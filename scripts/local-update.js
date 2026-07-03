/**
 * local-update.js
 * Quét toàn bộ dữ liệu trận đấu và tỷ số từ API gốc (worldcup26.ir) và đồng bộ thẳng vào MongoDB Atlas của bạn.
 * Đồng bộ toàn bộ 104 trận đấu bao gồm tỷ số, cầu thủ ghi bàn, loạt sút luân lưu và các đội lọt vào vòng trong.
 */
const { MongoClient } = require("mongodb");
const https = require("https");

const MONGO_URI = process.argv[2] || process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/worldcup2026";
const MATCH_COLLECTION = "games";

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP Status Code: ${res.statusCode}`));
        return;
      }
      let rawData = "";
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function recalculateStandings(db) {
  const matches = await db.collection(MATCH_COLLECTION).find({ finished: "TRUE", type: "group" }).toArray();
  const teams = await db.collection("teams").find({}).toArray();

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

  const groups = await db.collection("groups").find({}).toArray();
  for (const g of groups) {
    const updatedTeams = g.teams.map(t => {
      const s = stats[t.team_id];
      if (!s) return t;
      return { team_id: t.team_id, mp: String(s.mp), w: String(s.w), d: String(s.d), l: String(s.l), pts: String(s.pts), gf: String(s.gf), ga: String(s.ga), gd: String(s.gd) };
    });
    updatedTeams.sort((a, b) => (parseInt(b.pts) - parseInt(a.pts)) || (parseInt(b.gd) - parseInt(a.gd)) || (parseInt(b.gf) - parseInt(a.gf)));
    await db.collection("groups").updateOne({ _id: g._id }, { $set: { teams: updatedTeams } });
  }
}

async function main() {
  console.log("MONGO_URI sử dụng:", MONGO_URI);
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db();
    console.log("✅ Đã kết nối thành công đến MongoDB database:", db.databaseName);

    console.log("🔄 Đang tải dữ liệu gốc từ API developer (worldcup26.ir/get/games)...");
    const apiData = await httpGetJSON("https://worldcup26.ir/get/games");
    if (!apiData || !Array.isArray(apiData.games)) {
      console.error("❌ Dữ liệu API không đúng cấu trúc hoặc không tải được.");
      return;
    }

    console.log(`🔄 Tìm thấy ${apiData.games.length} trận đấu từ API. Bắt đầu đồng bộ...`);
    let updatedCount = 0;

    for (const g of apiData.games) {
      const matchId = String(g.id);

      const updateData = {
        home_score: String(g.home_score ?? "0"),
        away_score: String(g.away_score ?? "0"),
        home_penalty_score: g.home_penalty_score,
        away_penalty_score: g.away_penalty_score,
        home_scorers: g.home_scorers,
        away_scorers: g.away_scorers,
        finished: String(g.finished).toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
        time_elapsed: g.time_elapsed || "notstarted",
        winner_team_id: g.winner_team_id,
        home_team_id: g.home_team_id,
        away_team_id: g.away_team_id
      };

      const result = await db.collection(MATCH_COLLECTION).updateOne(
        { id: matchId },
        { $set: updateData }
      );

      if (result.modifiedCount > 0 || result.matchedCount > 0) {
        // Luôn ghi nhận đã đồng bộ
        if (result.modifiedCount > 0) {
          updatedCount++;
          console.log(`[Đồng bộ] Trận ${matchId}: ${g.home_team_name_en} ${g.home_score} - ${g.away_score} ${g.away_team_name_en} (${g.finished === "TRUE" ? 'Kết thúc' : 'Chưa đá/Đang đá'})`);
        }
      }
    }

    console.log("🔄 Đang tính toán lại bảng xếp hạng (Standings)...");
    await recalculateStandings(db);

    console.log(`\n🎉 Hoàn tất đồng bộ database! Tổng cộng đã cập nhật ${updatedCount} trận đấu mới.`);
  } catch (err) {
    console.error("❌ Lỗi nghiêm trọng:", err.message);
  } finally {
    await client.close();
  }
}

main();
