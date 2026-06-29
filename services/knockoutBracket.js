const FINISHED_VALUES = new Set([true, 1, "1", "TRUE", "true", "finished", "FINISHED"]);

function isFinished(match) {
    return FINISHED_VALUES.has(match?.finished) || match?.time_elapsed === "finished";
}

function validTeamId(value) {
    const id = value == null ? "" : String(value);
    return id && id !== "0" ? id : null;
}

function numericScore(value) {
    if (value === "" || value == null) return null;
    const score = Number(value);
    return Number.isFinite(score) ? score : null;
}

function getWinnerTeamId(match) {
    const explicitWinner = validTeamId(match?.winner_team_id);
    if (explicitWinner) return explicitWinner;

    const homeTeamId = validTeamId(match?.home_team_id);
    const awayTeamId = validTeamId(match?.away_team_id);
    if (!homeTeamId || !awayTeamId) return null;

    const homeScore = numericScore(match.home_score);
    const awayScore = numericScore(match.away_score);
    if (homeScore == null || awayScore == null) return null;
    if (homeScore > awayScore) return homeTeamId;
    if (awayScore > homeScore) return awayTeamId;

    const homePenalties = numericScore(
        match.home_penalty_score ?? match.home_penalties ?? match.penalty_home
    );
    const awayPenalties = numericScore(
        match.away_penalty_score ?? match.away_penalties ?? match.penalty_away
    );
    if (homePenalties == null || awayPenalties == null) return null;
    if (homePenalties > awayPenalties) return homeTeamId;
    if (awayPenalties > homePenalties) return awayTeamId;
    return null;
}

function isRoundOf32(match) {
    return String(match?.type || "").toLowerCase() === "r32" ||
        String(match?.group || "").toUpperCase() === "R32";
}

async function advanceRoundOf32Match(matches, match) {
    if (!isRoundOf32(match) || !isFinished(match)) {
        return { advanced: false, reason: "match_not_finished_r32" };
    }

    const winnerTeamId = getWinnerTeamId(match);
    if (!winnerTeamId) {
        return { advanced: false, reason: "winner_not_determined" };
    }

    const sourceLabel = `Winner Match ${match.id}`;
    const nextMatch = await matches.findOne({
        type: "r16",
        $or: [
            { home_team_label: sourceLabel },
            { away_team_label: sourceLabel }
        ]
    });

    if (!nextMatch) {
        return { advanced: false, reason: "next_match_not_found", sourceLabel };
    }

    const field = nextMatch.home_team_label === sourceLabel
        ? "home_team_id"
        : "away_team_id";

    if (String(nextMatch[field]) === winnerTeamId) {
        return {
            advanced: false,
            reason: "already_advanced",
            winnerTeamId,
            nextMatchId: nextMatch.id,
            field
        };
    }

    await matches.updateOne(
        { _id: nextMatch._id },
        { $set: { [field]: winnerTeamId } }
    );

    return {
        advanced: true,
        winnerTeamId,
        nextMatchId: nextMatch.id,
        field
    };
}

async function advanceRoundOf32Winners(db, collectionName = "games") {
    const matches = db.collection(collectionName);
    const finishedMatches = await matches.find({
        $and: [
            { $or: [{ type: "r32" }, { group: "R32" }] },
            { $or: [
                { finished: { $in: ["TRUE", "true", true, 1, "1", "finished", "FINISHED"] } },
                { time_elapsed: "finished" }
            ] }
        ]
    }).toArray();

    const results = [];
    for (const match of finishedMatches) {
        results.push(await advanceRoundOf32Match(matches, match));
    }
    return results;
}

module.exports = {
    advanceRoundOf32Match,
    advanceRoundOf32Winners,
    getWinnerTeamId,
    isFinished,
    isRoundOf32
};
