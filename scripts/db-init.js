/**
 * db-init.js
 * Chạy khi khởi động Render để khởi tạo DB và tự động cập nhật kết quả các trận đấu đã qua.
 */
require("dotenv").config();
const { MongoClient } = require("mongodb");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MONGO_URI = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/worldcup2026";
const MATCH_COLLECTION = "games";

function runCmd(cmd) {
    try {
        console.log(`Running: ${cmd}`);
        execSync(cmd, { stdio: "inherit" });
    } catch (err) {
        console.error(`Command failed: ${cmd}`, err.message);
        throw err;
    }
}

async function main() {
    const client = new MongoClient(MONGO_URI);
    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db();

        // 1. Kiểm tra xem DB đã được nạp dữ liệu chưa (nếu chưa thì mới nạp để tránh xóa mất dữ liệu cũ khi Render restart)
        const matchCount = await db.collection(MATCH_COLLECTION).countDocuments();
        if (matchCount === 0) {
            console.log("Database is empty. Seeding initial data...");
            runCmd("node import-groups.js");
            runCmd("node import-teams.js");
            runCmd("node import-stadiums.js");
            runCmd("node import-matches.js");
            console.log("Seeding complete!");
        } else {
            console.log(`Database already seeded with ${matchCount} matches. Skipping initial seed.`);
        }

        // 2. Đọc file ánh xạ tên đội tuyển
        const mapPath = path.join(__dirname, "../data/team-name-map.json");
        if (!fs.existsSync(mapPath)) {
            console.error(`Error: Mapping file not found at ${mapPath}`);
            return;
        }
        const TEAM_MAP = JSON.parse(fs.readFileSync(mapPath, "utf8"));

        const getEnglishName = (faName) => {
            if (!faName) return "";
            const name = faName.trim();
            return TEAM_MAP[name] || name;
        };

        // 3. Quét kết quả thi đấu từ ngày 11/06 (offset -25) đến hôm nay (offset 0)
        console.log("Fetching historical results from Varzesh3...");
        for (let offset = 0; offset >= -25; offset--) {
            try {
                const url = offset === 0
                    ? "https://web-api.varzesh3.com/v2.0/livescore/today"
                    : `https://web-api.varzesh3.com/v2.0/livescore/${offset}`;

                console.log(`Fetching offset ${offset}...`);
                const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) continue;

                const data = await res.json();
                if (!Array.isArray(data)) continue;

                for (const league of data) {
                    if (league.id !== 28) continue; // World Cup League ID
                    for (const dg of league.dates || []) {
                        for (const m of dg.matches || []) {
                            const hostFa = m.host?.name;
                            const guestFa = m.guest?.name;
                            if (!hostFa || !guestFa) continue;

                            const hostEn = getEnglishName(hostFa);
                            const guestEn = getEnglishName(guestFa);
                            const hostGoals = m.goals?.host;
                            const guestGoals = m.goals?.guest;
                            const isFinished = m.status === 7;

                            if (hostGoals === undefined || guestGoals === undefined) continue;

                            // Tìm trận đấu tương ứng trong DB bằng tên tiếng Anh
                            const query = {
                                $or: [
                                    { home_team_name_en: hostEn, away_team_name_en: guestEn },
                                    { home_team_name_en: guestEn, away_team_name_en: hostEn }
                                ]
                            };

                            const match = await db.collection(MATCH_COLLECTION).findOne(query);
                            if (match) {
                                const homeIsHost = match.home_team_name_en === hostEn;
                                const homeScore = homeIsHost ? String(hostGoals) : String(guestGoals);
                                const awayScore = homeIsHost ? String(guestGoals) : String(hostGoals);

                                let winner_team_id = null;
                                if (isFinished) {
                                    const hs = parseInt(homeScore);
                                    const as = parseInt(awayScore);
                                    if (hs > as) {
                                        winner_team_id = match.home_team_id;
                                    } else if (as > hs) {
                                        winner_team_id = match.away_team_id;
                                    } else {
                                        winner_team_id = null; // Hòa
                                    }
                                }

                                const updateData = {
                                    home_score: homeScore,
                                    away_score: awayScore,
                                    finished: isFinished ? "TRUE" : "FALSE",
                                    time_elapsed: isFinished ? "finished" : (m.isLive ? "live" : "notstarted"),
                                    winner_team_id: winner_team_id
                                };

                                await db.collection(MATCH_COLLECTION).updateOne(
                                    { _id: match._id },
                                    { $set: updateData }
                                );
                                console.log(`Updated: ${match.home_team_name_en} ${homeScore} - ${awayScore} ${match.away_team_name_en} (${isFinished ? 'Finished' : 'Live'})`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn(`Error on offset ${offset}:`, err.message);
            }
        }

        console.log("Database initialized and results updated successfully!");
    } catch (err) {
        console.error("Initialization failed:", err);
        process.exit(1);
    } finally {
        await client.close();
    }
}

main();
