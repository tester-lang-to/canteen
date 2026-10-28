
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const path = require("path");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "20kb" }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "canteen_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

const PORT = Number(process.env.PORT || 3000);
const CANTEEN_USER_ID = Number(process.env.CANTEEN_USER_ID);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      message: "Canteen API and MySQL are connected.",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      success: false,
      message: "Database connection failed.",
    });
  }
});

app.get("/api/student/:qr", async (req, res) => {
  const qr = String(req.params.qr || "").trim();

  if (!qr || qr.length > 150) {
    return res.status(400).json({
      success: false,
      message: "Invalid QR code.",
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT
         s.StudentID,
         s.StudentCode,
         s.FullName,
         s.PhotoPath,
         s.CurrentPoints,
         se.FullName AS SenseiName
       FROM Students s
       LEFT JOIN Sensei se ON se.SenseiID = s.SenseiID
       WHERE s.QRCodeValue = ?
         AND s.IsActive = TRUE
       LIMIT 1`,
      [qr]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found or inactive.",
      });
    }

    res.json({
      success: true,
      student: rows[0],
    });
  } catch (error) {
    console.error("Student lookup failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to look up student.",
    });
  }
});

app.post("/api/claim", async (req, res) => {
  const qr = String(req.body.qrCode || "").trim();
  const mealDate = String(req.body.mealDate || "");
  const mealPeriod = String(req.body.mealPeriod || "").toUpperCase();

  if (!qr || qr.length > 150) {
    return res.status(400).json({
      success: false,
      message: "A valid QR code is required.",
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return res.status(400).json({
      success: false,
      message: "mealDate must use YYYY-MM-DD format.",
    });
  }

  const validPeriods = ["BREAKFAST", "LUNCH", "DINNER"];

  if (!validPeriods.includes(mealPeriod)) {
    return res.status(400).json({
      success: false,
      message: "Invalid meal period.",
    });
  }

  if (
    !Number.isSafeInteger(CANTEEN_USER_ID) ||
    CANTEEN_USER_ID <= 0
  ) {
    return res.status(500).json({
      success: false,
      message: "Configure CANTEEN_USER_ID in .env.",
    });
  }

  try {
    const [resultSets] = await pool.query(
      "CALL ClaimStudentMeal(?, ?, ?, ?)",
      [qr, mealDate, mealPeriod, CANTEEN_USER_ID]
    );

    // MySQL CALL returns the procedure's SELECT result in
    // the first result set.
    const result = Array.isArray(resultSets[0])
      ? resultSets[0][0]
      : null;

    if (!result) {
      return res.status(500).json({
        success: false,
        message: "The procedure returned no result.",
      });
    }

    const succeeded = result.Result === "SUCCESS";

    res.status(succeeded ? 200 : 409).json({
      success: succeeded,
      ...result,
    });
  } catch (error) {
    console.error("Meal claim failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to process meal claim.",
    });
  }
});

app.get("/api/meal-preview/:qr", async (req, res) => {
  const qr = String(req.params.qr || "").trim();
  const mealDate = String(req.query.date || "");
  const mealPeriod = String(req.query.period || "").toUpperCase();

  if (!qr || qr.length > 150) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid student QR code."
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate) ||
      !["BREAKFAST", "LUNCH", "DINNER"].includes(mealPeriod)) {
    return res.status(400).json({
      success: false,
      message: "Invalid meal date or period."
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT
         s.StudentID,
         s.StudentCode,
         s.FullName,
         s.PhotoPath,
         s.CurrentPoints,
         se.FullName AS SenseiName,
         wmp.MealPlanID,
         wmp.MealType,
         mp.Price AS MealPrice,
         mc.ClaimID,
         mc.ClaimedAt
       FROM Students s
       LEFT JOIN Sensei se
         ON se.SenseiID = s.SenseiID
       LEFT JOIN WeeklyMealPlans wmp
         ON wmp.StudentID = s.StudentID
         AND wmp.MealDate = ?
         AND wmp.MealPeriod = ?
       LEFT JOIN MealPrices mp
         ON mp.MealType = wmp.MealType
         AND mp.ValidFrom <= NOW()
         AND (mp.ValidTo IS NULL OR mp.ValidTo > NOW())
       LEFT JOIN MealClaims mc
         ON mc.StudentID = s.StudentID
         AND mc.MealDate = ?
         AND mc.MealPeriod = ?
       WHERE s.QRCodeValue = ?
         AND s.IsActive = TRUE
       LIMIT 1`,
      [mealDate, mealPeriod, mealDate, mealPeriod, qr]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Student not found or inactive."
      });
    }

    const row = rows[0];

    res.json({
      success: true,
      student: {
        studentId: row.StudentID,
        studentCode: row.StudentCode,
        fullName: row.FullName,
        photoPath: row.PhotoPath,
        senseiName: row.SenseiName,
        currentPoints: Number(row.CurrentPoints)
      },
      meal: row.MealPlanID ? {
        mealPlanId: row.MealPlanID,
        mealType: row.MealType,
        price: row.MealPrice == null
          ? null
          : Number(row.MealPrice)
      } : null,
      alreadyClaimed: row.ClaimID != null,
      claimedAt: row.ClaimedAt
    });
  } catch (error) {
    console.error("Meal preview error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load meal information."
    });
  }
});


app.get("/api/dashboard-summary", async (req, res) => {
  const date = String(req.query.date || "");
  const period = String(req.query.period || "").toUpperCase();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !["BREAKFAST", "LUNCH", "DINNER"].includes(period)
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid date and meal period."
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT
         COUNT(CASE
           WHEN w.MealType IN ('REGULAR', 'EXTRA_RICE') THEN 1
         END) AS expectedMeals,

         COUNT(CASE
           WHEN mc.ClaimID IS NOT NULL THEN 1
         END) AS mealsServed,

         COUNT(CASE
           WHEN mc.ClaimID IS NOT NULL
             AND mc.MealType = 'REGULAR' THEN 1
         END) AS regularServed,

         COUNT(CASE
           WHEN mc.ClaimID IS NOT NULL
             AND mc.MealType = 'EXTRA_RICE' THEN 1
         END) AS extraRiceServed

       FROM WeeklyMealPlans w
       JOIN Students s ON s.StudentID = w.StudentID
       LEFT JOIN MealClaims mc
         ON mc.StudentID = w.StudentID
         AND mc.MealDate = w.MealDate
         AND mc.MealPeriod = w.MealPeriod

       WHERE w.MealDate = ?
         AND w.MealPeriod = ?
         AND s.IsActive = TRUE`,
      [date, period]
    );

    const row = rows[0];
    const expected = Number(row.expectedMeals || 0);
    const served = Number(row.mealsServed || 0);

    res.json({
      success: true,
      date,
      period,
      expectedMeals: expected,
      mealsServed: served,
      remainingMeals: Math.max(0, expected - served),
      regularServed: Number(row.regularServed || 0),
      extraRiceServed: Number(row.extraRiceServed || 0)
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load dashboard summary."
    });
  }
});


app.get("/api/dashboard-unserved", async (req, res) => {
  const date = String(req.query.date || "");
  const period = String(req.query.period || "").toUpperCase();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !["BREAKFAST", "LUNCH", "DINNER"].includes(period)
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid date and meal period."
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT
         s.StudentCode,
         s.FullName,
         se.FullName AS SenseiName,
         w.MealType
       FROM WeeklyMealPlans w
       JOIN Students s ON s.StudentID = w.StudentID
       LEFT JOIN Sensei se ON se.SenseiID = s.SenseiID
       LEFT JOIN MealClaims mc
         ON mc.StudentID = w.StudentID
         AND mc.MealDate = w.MealDate
         AND mc.MealPeriod = w.MealPeriod
       WHERE w.MealDate = ?
         AND w.MealPeriod = ?
         AND w.MealType IN ('REGULAR', 'EXTRA_RICE')
         AND mc.ClaimID IS NULL
         AND s.IsActive = TRUE
       ORDER BY s.FullName ASC`,
      [date, period]
    );

    res.json({
      success: true,
      date,
      period,
      count: rows.length,
      students: rows.map(row => ({
        studentCode: row.StudentCode,
        fullName: row.FullName,
        senseiName: row.SenseiName,
        mealType: row.MealType
      }))
    });
  } catch (error) {
    console.error("Unserved meals error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load unserved meals."
    });
  }
});




// Keep this API local during development.
// Do not expose it directly to the public Internet.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Canteen API running at http://127.0.0.1:${PORT}`);
});
