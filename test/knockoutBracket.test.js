const test = require("node:test");
const assert = require("node:assert/strict");
const {
    advanceRoundOf32Match,
    getWinnerTeamId
} = require("../services/knockoutBracket");

test("resolves a knockout winner from the final score", () => {
    assert.equal(getWinnerTeamId({
        home_team_id: "10",
        away_team_id: "20",
        home_score: "2",
        away_score: "1"
    }), "10");
});

test("uses the explicit provider winner when a shootout leaves the score tied", () => {
    assert.equal(getWinnerTeamId({
        home_team_id: "10",
        away_team_id: "20",
        home_score: "1",
        away_score: "1",
        winner_team_id: "20"
    }), "20");
});

test("advances the winner into the correct round-of-16 slot", async () => {
    const nextMatch = {
        _id: "mongo-89",
        id: "89",
        type: "r16",
        home_team_label: "Winner Match 74",
        away_team_label: "Winner Match 77",
        home_team_id: "0",
        away_team_id: "0"
    };
    const matches = {
        async findOne(query) {
            const labels = query.$or.map(item => Object.values(item)[0]);
            return labels.includes(nextMatch.home_team_label) ? nextMatch : null;
        },
        async updateOne(filter, update) {
            assert.deepEqual(filter, { _id: "mongo-89" });
            Object.assign(nextMatch, update.$set);
        }
    };

    const result = await advanceRoundOf32Match(matches, {
        id: "74",
        type: "r32",
        finished: "TRUE",
        home_team_id: "5",
        away_team_id: "9",
        home_score: "3",
        away_score: "1"
    });

    assert.equal(result.advanced, true);
    assert.equal(nextMatch.home_team_id, "5");
    assert.equal(nextMatch.away_team_id, "0");
});

test("does not advance a tied match without a shootout winner", async () => {
    let queried = false;
    const result = await advanceRoundOf32Match({
        async findOne() {
            queried = true;
        }
    }, {
        id: "74",
        type: "r32",
        finished: "TRUE",
        home_team_id: "5",
        away_team_id: "9",
        home_score: "1",
        away_score: "1"
    });

    assert.equal(result.reason, "winner_not_determined");
    assert.equal(queried, false);
});

test("does not rewrite a round-of-16 slot that already has the winner", async () => {
    let updated = false;
    const result = await advanceRoundOf32Match({
        async findOne() {
            return {
                _id: "mongo-89",
                id: "89",
                type: "r16",
                home_team_label: "Winner Match 74",
                away_team_label: "Winner Match 77",
                home_team_id: "5"
            };
        },
        async updateOne() {
            updated = true;
        }
    }, {
        id: "74",
        type: "r32",
        finished: "TRUE",
        home_team_id: "5",
        away_team_id: "9",
        home_score: "2",
        away_score: "0"
    });

    assert.equal(result.reason, "already_advanced");
    assert.equal(updated, false);
});
