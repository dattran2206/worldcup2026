/**
 * db-init.js
 * Chạy khi khởi động Render để khởi tạo DB và tự động cập nhật kết quả các trận đấu đã qua.
 * Tự chứa (Self-contained) bản đồ dịch ngôn ngữ để không bị crash bởi file JSON gốc bị lỗi.
 */
require("dotenv").config();
const { MongoClient } = require("mongodb");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MONGO_URI = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/worldcup2026";
const MATCH_COLLECTION = "games";

// Bản đồ dịch tên đội tuyển từ tiếng Ba Tư sang tiếng Anh (Được nhúng trực tiếp tránh lỗi file JSON gốc bị hỏng)
const TEAM_MAP = {
    "الجزایر": "Algeria",
    "آرژانتین": "Argentina",
    "استرالیا": "Australia",
    "اتریش": "Austria",
    "بلژیک": "Belgium",
    "بوسنی و هرزگوین": "Bosnia and Herzegovina",
    "بوسنی": "Bosnia and Herzegovina",
    "برزیل": "Brazil",
    "کانادا": "Canada",
    "کیپ ورد": "Cape Verde",
    "کلمبیا": "Colombia",
    "کرواسی": "Croatia",
    "کوراسائو": "Curaçao",
    "جمهوری چک": "Czech Republic",
    "جمهوری دموکراتیک کنگو": "Democratic Republic of the Congo",
    "جمهوری کنگو": "Democratic Republic of the Congo",
    "اکوادور": "Ecuador",
    "مصر": "Egypt",
    "انگلستان": "England",
    "انگلیس": "England",
    "فرانسه": "France",
    "آلمان": "Germany",
    "غنا": "Ghana",
    "هائیتی": "Haiti",
    "ایران": "Iran",
    "عراق": "Iraq",
    "ایتالیا": "Italy",
    "ساحل عاج": "Ivory Coast",
    "ژاپن": "Japan",
    "اردن": "Jordan",
    "مکزیک": "Mexico",
    "مراکش": "Morocco",
    "هلند": "Netherlands",
    "نیوزیلند": "New Zealand",
    "نروژ": "Norway",
    "پاناما": "Panama",
    "پاراگوئه": "Paraguay",
    "پرتغال": "Portugal",
    "قطر": "Qatar",
    "عربستان": "Saudi Arabia",
    "عربستان سعودی": "Saudi Arabia",
    "اسکاتلند": "Scotland",
    "سنگال": "Senegal",
    "آفریقای جنوبی": "South Africa",
    "کره جنوبی": "South Korea",
    "اسپانیا": "Spain",
    "سوئیس": "Switzerland",
    "سوئد": "Sweden",
    "تونس": "Tunisia",
    "ترکیه": "Turkey",
    "اوکراین": "Ukraine",
    "ایالات متحده": "United States",
    "آمریکا": "United States",
    "اروگوئه": "Uruguay",
    "ازبکستان": "Uzbekistan"
};

function runCmd(cmd) {
    try {
        console.log(`Running: ${cmd}`);
        execSync(cmd, { stdio: "inherit" });
    } catch (err) {
        console.error(`Command failed: ${cmd}`, err.message);
    }
}

async function main() {
    const client = new MongoClient(MONGO_URI);
    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db();

        // 1. Kiểm tra xem DB đã được nạp dữ liệu chưa
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

        const getEnglishName = (faName) => {
            if (!faName) return "";
            const name = faName.trim();
            return TEAM_MAP[name] || name;
        };

        // 2. Quét kết quả thi đấu từ ngày khai mạc (offset -25) đến hôm nay (offset 0)
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
                    if (league.id !== 28) continue; // World Cup
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
                                        winner_team_id = null;
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
        console.error("Initialization warning:", err);
    } finally {
        await client.close();
        // Đảm bảo script luôn thoát với code 0 để Render không từ chối khởi chạy Web Server
        process.exit(0);
    }
}

main();
