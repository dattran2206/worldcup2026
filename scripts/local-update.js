/**
 * local-update.js
 * Quét tỷ số trực tiếp và lịch sử từ Varzesh3 và lưu thẳng vào MongoDB Atlas của bạn.
 * Chạy lệnh này trên máy tính cá nhân để tránh việc các dải IP Cloud của Render bị phía Iran chặn.
*/
const { MongoClient } = require("mongodb");
const https = require("https");

const MONGO_URI = process.argv[2] || process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/worldcup2026";
const MATCH_COLLECTION = "games";

// Bản đồ dịch tên đội tuyển từ tiếng Ba Tư sang tiếng Anh
const TEAM_MAP = {
  "الجزایر": "Algeria",
  "آرژانتین": "Argentina",
  "استرالیا": "Australia",
  "اتریش": "Austria",
  "بلژیک": "Belgium",
  "بوسنی và هرزگوین": "Bosnia and Herzegovina",
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
  "ردون": "Jordan",
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
  "آfریقay جنوبی": "South Africa",
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

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
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

async function main() {
  console.log("MONGO_URI sử dụng:", MONGO_URI);
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db();
    console.log("✅ Đã kết nối thành công đến MongoDB database:", db.databaseName);

    const getEnglishName = (faName) => {
      if (!faName) return "";
      const name = faName.trim();
      return TEAM_MAP[name] || name;
    };

    console.log("🔄 Bắt đầu tải dữ liệu kết quả từ Varzesh3...");
    let updatedCount = 0;

    // Quét toàn bộ kết quả từ ngày 11/06 (offset -25) đến hôm nay (offset 0)
    for (let offset = 0; offset >= -25; offset--) {
      try {
        const url = offset === 0
          ? "https://web-api.varzesh3.com/v2.0/livescore/today"
          : `https://web-api.varzesh3.com/v2.0/livescore/${offset}`;

        console.log(`Đang tải kết quả của ngày offset: ${offset}...`);
        const data = await httpGetJSON(url);
        if (!Array.isArray(data)) continue;

        for (const league of data) {
          if (league.id !== 28) continue; // ID giải World Cup
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

                const updateResult = await db.collection(MATCH_COLLECTION).updateOne(
                  { _id: match._id },
                  { $set: updateData }
                );

                if (updateResult.modifiedCount > 0) {
                  updatedCount++;
                  console.log(`[Cập nhật] ${match.home_team_name_en} ${homeScore} - ${awayScore} ${match.away_team_name_en}`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Lỗi khi quét ngày offset ${offset}:`, err.message);
      }
    }
    console.log(`🎉 Hoàn tất cập nhật database! Tổng cộng đã sửa đổi ${updatedCount} trận đấu.`);
  } catch (err) {
    console.error("❌ Lỗi nghiêm trọng:", err.message);
  } finally {
    await client.close();
  }
}

main();
