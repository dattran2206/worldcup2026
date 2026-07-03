/**
 * World Cup 2026 — In-Process Live Updater
 * 
 * Runs inside the Express server process (no separate worker needed).
 * Reuses the existing Mongoose connection to update match scores in real-time.
 * 
 * Adapted from scripts/auto-updater.js for production deployment on Render
 * where only a single web process is available.
 */

const fs = require('fs');
const path = require('path');
// Use the project's shared mongoose instance (which already has the connection setup)
const mongoose = require('../database');
const { advanceRoundOf32Winners } = require('./knockoutBracket');

const MATCH_COLLECTION = process.env.MATCH_COLLECTION || 'games';
const POLL_INTERVAL = parseInt(process.env.LIVE_POLL_INTERVAL || '5000'); // 5s default

// Load team name map (Persian → English)
let TEAM_MAP = {};
try {
  TEAM_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/team-name-map.json'), 'utf8'));
} catch (err) {
  console.error('[live-updater] ⚠️ Could not load team-name-map.json:', err.message);
}

// Load player name DB
let playerDb = {};
try {
  playerDb = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/player-names.json'), 'utf8'));
} catch (err) {
  console.warn('[live-updater] ⚠️ Could not load player-names.json:', err.message);
}

function getPlayerName(id, faName) {
  const sid = String(id);
  if (playerDb[sid]) return playerDb[sid];
  // Save unknown player for later manual mapping
  if (sid && faName && !playerDb[sid]) {
    playerDb[sid] = faName;
    try {
      fs.writeFileSync(path.join(__dirname, '../data/player-names.json'), JSON.stringify(playerDb, null, 2));
    } catch { /* ignore write errors in production */ }
  }
  return faName;
}

function mapStatus(status, liveTime, isLive) {
  if (isLive) return liveTime || 'Live';
  if (status === 7) return 'finished';
  return 'notstarted';
}

async function fetchVarzesh3(dayOffset) {
  const url = dayOffset === 0
    ? 'https://web-api.varzesh3.com/v2.0/livescore/today'
    : `https://web-api.varzesh3.com/v2.0/livescore/${dayOffset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  const matches = [];
  for (const league of data) {
    if (league.id !== 28) continue; // World Cup league ID on Varzesh3
    for (const dg of league.dates || []) {
      for (const m of dg.matches || []) matches.push(m);
    }
  }
  return matches;
}

async function fetchEvents(matchId) {
  try {
    const res = await fetch(
      `https://web-api.varzesh3.com/v2.0/livescore/football/matches/${matchId}/events`,
      { signal: AbortSignal.timeout(5000) }
    );
    const events = await res.json();
    const homeGoals = [], awayGoals = [];
    for (const e of events) {
      if (e.eventType === 1 || e.eventType === 3) {
        const id = e.strikerId || e.kickerId || '';
        const name = getPlayerName(id, e.strickerName || e.kickerName || 'Goal');
        const time = e.time || '';
        const pen = e.eventType === 3 ? '(p)' : '';
        homeGoals.push(...(e.side === 0 ? [`"${name} ${time}'${pen}"`] : []));
        awayGoals.push(...(e.side === 1 ? [`"${name} ${time}'${pen}"`] : []));
      }
    }
    return {
      home_scorers: homeGoals.length ? `{${homeGoals.join(',')}}` : 'null',
      away_scorers: awayGoals.length ? `{${awayGoals.join(',')}}` : 'null',
    };
  } catch { return null; }
}

async function syncMatches(v3Matches, db) {
  const teams = await db.collection('teams').find({}).toArray();
  const teamByFa = {};
  for (const t of teams) teamByFa[t.name_fa] = t.id;
  for (const [fa, en] of Object.entries(TEAM_MAP)) {
    const team = teams.find(t => t.name_en === en);
    if (team) teamByFa[fa] = team.id;
  }

  const matches = db.collection(MATCH_COLLECTION);
  let updated = 0;

  for (const m of v3Matches) {
    const homeTeamId = teamByFa[m.host?.name];
    const awayTeamId = teamByFa[m.guest?.name];
    if (!homeTeamId || !awayTeamId) continue;

    const match = await matches.findOne({
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      finished: { $nin: ['TRUE', true] }
    }, { sort: { date: -1 } });
    if (!match) continue;

    const newData = {
      home_score: String(m.goals?.host ?? match.home_score),
      away_score: String(m.goals?.guest ?? match.away_score),
      time_elapsed: mapStatus(m.status, m.liveTime, m.isLive),
      finished: m.status === 7 ? 'TRUE' : match.finished,
    };
    if (m.status === 7 && (m.winner === 0 || m.winner === 1)) {
      newData.winner_team_id = m.winner === 0 ? homeTeamId : awayTeamId;
    }

    if (m.isLive || m.status === 7) {
      const scorers = await fetchEvents(m.id);
      if (scorers) {
        newData.home_scorers = scorers.home_scorers;
        newData.away_scorers = scorers.away_scorers;
      }
    }

    if (match.home_score !== newData.home_score || match.away_score !== newData.away_score ||
        match.time_elapsed !== newData.time_elapsed || match.finished !== newData.finished ||
        match.home_scorers !== newData.home_scorers) {
      await matches.updateOne({ _id: match._id }, { $set: newData });
      updated++;
    }
  }
  return updated;
}

async function updateStandings(db) {
  const matches = await db.collection(MATCH_COLLECTION).find({ finished: 'TRUE', type: 'group' }).toArray();
  const teams = await db.collection('teams').find({}).toArray();

  const stats = {};
  for (const t of teams) {
    stats[t.id] = { team_id: t.id, mp: 0, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, gd: 0 };
  }

  for (const m of matches) {
    const h = parseInt(m.home_score) || 0;
    const a = parseInt(m.away_score) || 0;
    const home = stats[m.home_team_id];
    const away = stats[m.away_team_id];
    if (!home || !away) continue;

    home.mp++; away.mp++;
    home.gf += h; home.ga += a;
    away.gf += a; away.ga += h;

    if (h > a) { home.w++; home.pts += 3; away.l++; }
    else if (h < a) { away.w++; away.pts += 3; home.l++; }
    else { home.d++; away.d++; home.pts++; away.pts++; }

    home.gd = home.gf - home.ga;
    away.gd = away.gf - away.ga;
  }

  const groups = await db.collection('groups').find({}).toArray();
  for (const g of groups) {
    const updatedTeams = g.teams.map(t => {
      const s = stats[t.team_id];
      if (!s) return t;
      return { team_id: t.team_id, mp: String(s.mp), w: String(s.w), d: String(s.d), l: String(s.l), pts: String(s.pts), gf: String(s.gf), ga: String(s.ga), gd: String(s.gd) };
    });
    updatedTeams.sort((a, b) => (parseInt(b.pts) - parseInt(a.pts)) || (parseInt(b.gd) - parseInt(a.gd)) || (parseInt(b.gf) - parseInt(a.gf)));
    await db.collection('groups').updateOne({ _id: g._id }, { $set: { teams: updatedTeams } });
  }
}

// ── Main: In-process background updater ──────────────────────────────────────

let lastFinishedCount = 0;
let isRunning = false;

async function fullSync(db) {
  console.log('[live-updater] Full sync starting...');
  try {
    const allMatches = [];
    for (const d of [-2, -1, 0, 1]) {
      try { allMatches.push(...await fetchVarzesh3(d)); } catch {}
    }
    const updated = await syncMatches(allMatches, db);
    const advancements = await advanceRoundOf32Winners(db, MATCH_COLLECTION);
    await updateStandings(db);
    const advanced = advancements.filter(r => r.advanced).length;
    lastFinishedCount = await db.collection(MATCH_COLLECTION).countDocuments({ finished: 'TRUE' });
    console.log(`[live-updater] Full sync done: ${updated} matches updated, ${advanced} R32 winners advanced`);
  } catch (err) {
    console.error('[live-updater] Full sync error:', err.message);
  }
}

async function poll(db) {
  if (isRunning) return; // Prevent overlapping polls
  isRunning = true;
  try {
    const todayMatches = await fetchVarzesh3(0);
    const updated = await syncMatches(todayMatches, db);

    if (updated > 0) {
      // Game cache in getController will expire via TTL (10s)
      // No need to manually invalidate
    }

    const advancements = await advanceRoundOf32Winners(db, MATCH_COLLECTION);
    for (const result of advancements) {
      if (result.advanced) {
        console.log(`[live-updater] Team ${result.winnerTeamId} advanced to match ${result.nextMatchId}`);
      }
    }

    // Recalculate standings if a match just finished
    const count = await db.collection(MATCH_COLLECTION).countDocuments({ finished: 'TRUE' });
    if (count !== lastFinishedCount) {
      lastFinishedCount = count;
      await updateStandings(db);
      console.log(`[live-updater] Standings updated (${count} finished matches)`);
    }
  } catch (err) {
    console.error('[live-updater] Poll error:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the live updater as an in-process background task.
 * Call this after Mongoose has connected.
 */
function startLiveUpdater() {
  // Wait for Mongoose connection to be ready
  const conn = mongoose.connection;

  function begin() {
    const db = conn.db;
    console.log(`[live-updater] Starting — polling every ${POLL_INTERVAL}ms`);

    // Full sync on startup (fetch -2, -1, 0, +1 days)
    fullSync(db).then(() => {
      // Then poll every POLL_INTERVAL
      setInterval(() => poll(db), POLL_INTERVAL);
    });
  }

  if (conn.readyState === 1) {
    // Already connected
    begin();
  } else {
    // Wait for connection
    conn.once('connected', begin);
  }
}

module.exports = { startLiveUpdater };
