
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please log in to use the canteen system."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please log in first."
    });
  }

  if (req.session.user.role !== "ADMIN") {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required."
    });
  }

  next();
}
app.use(session({
  name: "canteen.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 8 * 60 * 60 * 1000
  }
}));
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


app.post("/api/claim", requireLogin, async (req, res) => {
  const qr = String(req.body?.qrCode || "").trim();
  const mealDate = String(req.body?.mealDate || "");
  const mealPeriod = String(req.body?.mealPeriod || "").toUpperCase();

  // Use the ID of the authenticated operator.
  const servedBy = req.session.user.userId;

  if (!qr || qr.length > 150) {
    return res.status(400).json({
      success: false,
      message: "A valid QR code is required."
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return res.status(400).json({
      success: false,
      message: "mealDate must use YYYY-MM-DD format."
    });
  }

  const validPeriods = ["BREAKFAST", "LUNCH", "DINNER"];

  if (!validPeriods.includes(mealPeriod)) {
    return res.status(400).json({
      success: false,
      message: "Invalid meal period."
    });
  }

  if (!Number.isSafeInteger(Number(servedBy)) || Number(servedBy) <= 0) {
    return res.status(401).json({
      success: false,
      message: "Your login session is invalid. Please log in again."
    });
  }

  try {
    const [resultSets] = await pool.query(
      "CALL ClaimStudentMeal(?, ?, ?, ?)",
      [qr, mealDate, mealPeriod, Number(servedBy)]
    );

    // MySQL CALL returns the procedure's SELECT result
    // in the first result set.
    const result = Array.isArray(resultSets[0])
      ? resultSets[0][0]
      : null;

    if (!result) {
      return res.status(500).json({
        success: false,
        message: "The procedure returned no result."
      });
    }

    const succeeded = result.Result === "SUCCESS";

    return res.status(succeeded ? 200 : 409).json({
      success: succeeded,
      ...result
    });
  } catch (error) {
    console.error("Meal claim failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to process meal claim."
    });
  }
});


app.get("/api/meal-preview/:qr", requireLogin, async (req, res) => {
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


app.get("/api/dashboard-summary", requireLogin, async (req, res) => {
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


app.get("/api/dashboard-unserved", requireLogin, async (req, res) => {
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


app.post("/api/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password || username.length > 100 || password.length > 200) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid username and password."
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT UserID, Username, PasswordHash, FullName, Role, IsActive
       FROM Users
       WHERE Username = ?
       LIMIT 1`,
      [username]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password."
      });
    }

    const user = rows[0];

    if (
      !user.IsActive ||
      !["ADMIN", "CANTEEN"].includes(String(user.Role).toUpperCase())
    ) {
      return res.status(403).json({
        success: false,
        message: "This account is not authorized to use the canteen system."
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.PasswordHash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password."
      });
    }

    req.session.user = {
      userId: user.UserID,
      username: user.Username,
      fullName: user.FullName,
      role: String(user.Role).toUpperCase()
    };

    req.session.save((error) => {
      if (error) {
        console.error("Login session error:", error);
        return res.status(500).json({
          success: false,
          message: "Unable to create login session."
        });
      }

      return res.json({
        success: true,
        message: "Login successful.",
        user: req.session.user
      });
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to log in."
    });
  }
});


app.post("/api/logout", requireLogin, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout error:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to log out."
      });
    }

    res.clearCookie("canteen.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/"
    });

    return res.json({
      success: true,
      message: "Logged out successfully."
    });
  });
});


app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Not logged in."
    });
  }

  return res.json({
    success: true,
    user: req.session.user
  });
});

app.get("/api/admin/students", requireAdmin, async (req, res) => {
  const search = String(req.query.search || "").trim();

  if (search.length > 100) {
    return res.status(400).json({
      success: false,
      message: "Search text is too long."
    });
  }

  try {
    let sql = `
      SELECT
        s.StudentID,
        s.StudentCode,
        s.QRCodeValue,
        s.FullName,
        s.PhotoPath,
        s.SenseiID,
        se.FullName AS SenseiName,
        s.CurrentPoints,
        s.IsActive,
        s.CreatedAt,
        s.UpdatedAt
      FROM Students s
      LEFT JOIN Sensei se
        ON se.SenseiID = s.SenseiID
    `;

    const params = [];

    if (search) {
      sql += `
        WHERE
          s.StudentCode LIKE ?
          OR s.FullName LIKE ?
      `;

      const keyword = `%${search}%`;
      params.push(keyword, keyword);
    }

    sql += `
      ORDER BY s.FullName ASC
      LIMIT 200
    `;

    const [rows] = await pool.execute(sql, params);

    return res.json({
      success: true,
      count: rows.length,
      students: rows
    });

  } catch (error) {
    console.error("Admin student list error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load students."
    });
  }
});

// ============================================
// ADMIN API: ADD STUDENT POINTS
// ============================================
app.post("/api/admin/points/add", requireAdmin, async (req, res) => {
  const { studentId, points, reason } = req.body;

  // Validate student ID
  const parsedStudentId = Number(studentId);

  if (
    !Number.isInteger(parsedStudentId) ||
    parsedStudentId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required."
    });
  }

  // Validate points
  const parsedPoints = Number(points);

  if (
    !Number.isFinite(parsedPoints) ||
    parsedPoints <= 0 ||
    parsedPoints > 1000000 ||
    Math.round(parsedPoints * 100) !== parsedPoints * 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Points must be greater than zero and have at most two decimal places."
    });
  }

  // Validate reason
  const cleanReason =
    typeof reason === "string" ? reason.trim() : "";

  if (!cleanReason || cleanReason.length > 300) {
    return res.status(400).json({
      success: false,
      message: "Please provide a reason of 1–300 characters."
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Lock the student record while updating the balance
    const [students] = await connection.execute(
      `SELECT StudentID, StudentCode, FullName, CurrentPoints, IsActive
       FROM Students
       WHERE StudentID = ?
       FOR UPDATE`,
      [parsedStudentId]
    );

    if (students.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Student not found."
      });
    }

    const student = students[0];

    if (Number(student.IsActive) !== 1) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "Cannot add points to an inactive student."
      });
    }

    const balanceBefore = Number(student.CurrentPoints);
    const balanceAfter = balanceBefore + parsedPoints;

    if (
      !Number.isFinite(balanceBefore) ||
      !Number.isFinite(balanceAfter) ||
      balanceAfter > 9999999999
    ) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "The resulting points balance is invalid or too large."
      });
    }

    // Update the student's balance
    await connection.execute(
      `UPDATE Students
       SET CurrentPoints = ?
       WHERE StudentID = ?`,
      [balanceAfter, parsedStudentId]
    );

    // Record the points transaction
    await connection.execute(
      `INSERT INTO PointsTransactions
       (
         TransactionUID,
         StudentID,
         TransactionType,
         PointsChange,
         BalanceBefore,
         BalanceAfter,
         Reason,
         CreatedBy
       )
       VALUES (UUID(), ?, 'ADMIN_CREDIT', ?, ?, ?, ?, ?)`,
      [
        parsedStudentId,
        parsedPoints,
        balanceBefore,
        balanceAfter,
        cleanReason,
        req.session.user.userId
      ]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Student points added successfully.",
      student: {
        studentId: student.StudentID,
        studentCode: student.StudentCode,
        fullName: student.FullName
      },
      transaction: {
        pointsAdded: parsedPoints,
        balanceBefore,
        balanceAfter,
        reason: cleanReason
      }
    });

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Points rollback error:", rollbackError.message);
      }
    }

    console.error("Admin add points error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to add points. Check the server terminal for details."
    });

  } finally {
    if (connection) {
      connection.release();
    }
  }
});


app.get("/api/admin/points/history/:studentId", requireAdmin, async (req, res) => {
  const studentId = Number(req.params.studentId);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required."
    });
  }

  try {
    const [students] = await pool.execute(
      "SELECT StudentID FROM Students WHERE StudentID = ?",
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found."
      });
    }

    const [transactions] = await pool.execute(
      `SELECT
         PointsTransactionID,
         TransactionType,
         PointsChange,
         BalanceBefore,
         BalanceAfter,
         Reason,
         CreatedAt
       FROM PointsTransactions
       WHERE StudentID = ?
       ORDER BY CreatedAt DESC, PointsTransactionID DESC
       LIMIT 100`,
      [studentId]
    );

    return res.json({
      success: true,
      transactions
    });
  } catch (error) {
    console.error("Points history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load points transaction history."
    });
  }
});



// Keep this API local during development.
// Do not expose it directly to the public Internet.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Canteen API running at http://127.0.0.1:${PORT}`);
});
