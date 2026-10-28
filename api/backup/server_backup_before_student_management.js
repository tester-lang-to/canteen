
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


app.get("/api/admin/meal-prices", requireAdmin, async (req, res) => {
  try {
    const [prices] = await pool.execute(
      `SELECT
         MealPriceID,
         MealType,
         Price,
         ValidFrom,
         ValidTo,
         CreatedBy,
         CreatedAt
       FROM MealPrices
       ORDER BY MealType ASC, ValidFrom DESC, MealPriceID DESC`
    );

    return res.json({
      success: true,
      prices
    });
  } catch (error) {
    console.error("Meal price list error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load meal prices."
    });
  }
});

app.post("/api/admin/meal-prices", requireAdmin, async (req, res) => {
  const mealType = req.body.mealType;
  const price = Number(req.body.price);

  if (!["REGULAR", "EXTRA_RICE"].includes(mealType)) {
    return res.status(400).json({
      success: false,
      message: "Select a valid meal type."
    });
  }

  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    price > 9999999999.99 ||
    Math.round(price * 100) !== price * 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Price must be greater than zero with at most two decimal places."
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Lock the existing price records for this meal type.
    const [existingPrices] = await connection.execute(
      `SELECT MealPriceID, Price, ValidFrom, ValidTo
       FROM MealPrices
       WHERE MealType = ?
       ORDER BY ValidFrom DESC, MealPriceID DESC
       FOR UPDATE`,
      [mealType]
    );

    const [activePrices] = await connection.execute(
      `SELECT MealPriceID, Price, ValidFrom, ValidTo
       FROM MealPrices
       WHERE MealType = ?
         AND ValidFrom <= NOW()
         AND (ValidTo IS NULL OR ValidTo > NOW())
       FOR UPDATE`,
      [mealType]
    );

    if (activePrices.length > 1) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "Multiple active prices exist for this meal type. Resolve the overlapping price records first."
      });
    }

    if (
      activePrices.length === 1 &&
      Number(activePrices[0].Price) === price
    ) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "This is already the active price. No changes were made."
      });
    }

    // Prevent inserting a price if a future price is already scheduled.
    const [futurePrices] = await connection.execute(
      `SELECT MealPriceID
       FROM MealPrices
       WHERE MealType = ?
         AND ValidFrom > NOW()
       LIMIT 1
       FOR UPDATE`,
      [mealType]
    );

    if (futurePrices.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "A future price is already scheduled. Review the price history before making another change."
      });
    }

    // Close the currently active record at the change time.
    if (activePrices.length === 1) {
      await connection.execute(
        `UPDATE MealPrices
         SET ValidTo = NOW()
         WHERE MealPriceID = ?
           AND ValidTo IS NULL`,
        [activePrices[0].MealPriceID]
      );
    }

    await connection.execute(
      `INSERT INTO MealPrices
         (MealType, Price, ValidFrom, ValidTo, CreatedBy)
       VALUES (?, ?, NOW(), NULL, ?)`,
      [mealType, price, req.session.user.userId]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Meal price updated successfully.",
      mealType,
      price
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Meal price rollback error:", rollbackError.message);
      }
    }

    console.error("Meal price update error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update meal price. Check the server terminal for details."
    });
  } finally {
    if (connection) connection.release();
  }
});


app.get("/api/admin/meal-plans", requireAdmin, async (req, res) => {
    try {
        const { date, studentId } = req.query;

        let sql = `
            SELECT
                mp.MealPlanID,
                mp.StudentID,
                s.StudentCode,
                s.FullName,
                mp.MealDate,
                mp.MealPeriod,
                mp.MealType,
                mp.SubmittedVia,
                mp.ExternalResponseID,
                mp.CreatedAt,
                mp.UpdatedAt
            FROM WeeklyMealPlans AS mp
            INNER JOIN Students AS s
                ON s.StudentID = mp.StudentID
            WHERE 1 = 1
        `;

        const params = [];

        if (date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid date format. Use YYYY-MM-DD."
                });
            }

            sql += " AND mp.MealDate = ?";
            params.push(date);
        }

        if (studentId) {
            if (!/^\d+$/.test(studentId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid student ID."
                });
            }

            sql += " AND mp.StudentID = ?";
            params.push(studentId);
        }

        sql += `
            ORDER BY
                mp.MealDate DESC,
                s.StudentCode ASC,
                FIELD(mp.MealPeriod, 'BREAKFAST', 'LUNCH', 'DINNER')
            LIMIT 500
        `;

        const [rows] = await pool.query(sql, params);

        res.json({
            success: true,
            mealPlans: rows
        });
    } catch (error) {
        console.error("Admin meal plans error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load meal plans."
        });
    }
});


app.put("/api/admin/meal-plans/:mealPlanId", requireAdmin, async (req, res) => {
    const mealPlanId = req.params.mealPlanId;
    const { mealType } = req.body;

    if (!/^\d+$/.test(mealPlanId) || Number(mealPlanId) <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid meal plan ID."
        });
    }

    const allowedMealTypes = ["REGULAR", "EXTRA_RICE", "NONE"];

    if (!allowedMealTypes.includes(mealType)) {
        return res.status(400).json({
            success: false,
            message: "Meal type must be REGULAR, EXTRA_RICE, or NONE."
        });
    }

    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Lock the meal plan so its old value is read safely.
        const [rows] = await connection.query(
            `SELECT MealPlanID, StudentID, MealDate, MealPeriod, MealType
             FROM WeeklyMealPlans
             WHERE MealPlanID = ?
             FOR UPDATE`,
            [Number(mealPlanId)]
        );

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Meal plan record not found."
            });
        }

        const oldPlan = rows[0];
        const oldMealType = oldPlan.MealType;

        if (oldMealType === mealType) {
            await connection.rollback();

            return res.json({
                success: true,
                message: "Meal plan is already set to that value.",
                mealPlanId: Number(mealPlanId),
                mealType: oldMealType
            });
        }

        // Update the meal plan.
        await connection.query(
            `UPDATE WeeklyMealPlans
             SET MealType = ?, SubmittedVia = 'ADMIN'
             WHERE MealPlanID = ?`,
            [mealType, Number(mealPlanId)]
        );

        // Record the edit in the audit log.
        await connection.query(
            `INSERT INTO AuditLogs
                (UserID, Action, EntityType, EntityID, Details, IPAddress)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.userId,
                "UPDATE",
                "WeeklyMealPlan",
                String(mealPlanId),
                JSON.stringify({
                    studentId: oldPlan.StudentID,
                    mealDate: oldPlan.MealDate,
                    mealPeriod: oldPlan.MealPeriod,
                    oldMealType,
                    newMealType: mealType
                }),
                req.ip || null
            ]
        );

        await connection.commit();

        res.json({
            success: true,
            message: "Meal plan updated and audit log recorded successfully.",
            mealPlanId: Number(mealPlanId),
            oldMealType,
            mealType
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Meal plan rollback error:", rollbackError);
            }
        }

        console.error("Admin meal plan update error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to update meal plan."
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});



app.post("/api/admin/meal-plans", requireAdmin, async (req, res) => {
    const { studentId, mealDate, mealPeriod, mealType } = req.body;

    if (!/^\d+$/.test(String(studentId ?? "")) || Number(studentId) <= 0) {
        return res.status(400).json({
            success: false,
            message: "Please select a valid student."
        });
    }

    if (
        typeof mealDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(mealDate)
    ) {
        return res.status(400).json({
            success: false,
            message: "Please provide a valid meal date in YYYY-MM-DD format."
        });
    }

    const parsedDate = new Date(`${mealDate}T00:00:00Z`);

    if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== mealDate
    ) {
        return res.status(400).json({
            success: false,
            message: "The meal date is not a valid calendar date."
        });
    }

    if (!["BREAKFAST", "LUNCH", "DINNER"].includes(mealPeriod)) {
        return res.status(400).json({
            success: false,
            message: "Meal period must be BREAKFAST, LUNCH, or DINNER."
        });
    }

    if (!["REGULAR", "EXTRA_RICE", "NONE"].includes(mealType)) {
        return res.status(400).json({
            success: false,
            message: "Meal type must be REGULAR, EXTRA_RICE, or NONE."
        });
    }

    try {
        const [students] = await pool.query(
            "SELECT StudentID FROM Students WHERE StudentID = ? AND IsActive = 1",
            [Number(studentId)]
        );

        if (students.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Active student not found."
            });
        }

        
const connection = await pool.getConnection();

let createdMealPlanId;

try {
    await connection.beginTransaction();

    const [insertResult] = await connection.query(
        `INSERT INTO WeeklyMealPlans
            (StudentID, MealDate, MealPeriod, MealType, SubmittedVia)
         VALUES (?, ?, ?, ?, 'ADMIN')`,
        [Number(studentId), mealDate, mealPeriod, mealType]
    );

    createdMealPlanId = insertResult.insertId;

    await connection.query(
        `INSERT INTO AuditLogs
            (UserID, Action, EntityType, EntityID, Details, IPAddress)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            req.session.user.userId,
            "CREATE",
            "WeeklyMealPlan",
            String(createdMealPlanId),
            JSON.stringify({
                studentId: Number(studentId),
                mealDate,
                mealPeriod,
                mealType
            }),
            req.ip || null
        ]
    );

    await connection.commit();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
}


        res.status(201).json({
            success: true,
            message: "Meal plan created successfully."
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "A meal plan already exists for this student, date, and meal period. Edit the existing record instead."
            });
        }

        console.error("Admin meal plan create error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create meal plan."
        });
    }
});



app.delete("/api/admin/meal-plans/:mealPlanId", requireAdmin, async (req, res) => {
    const mealPlanId = req.params.mealPlanId;

    if (!/^\d+$/.test(mealPlanId) || Number(mealPlanId) <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid meal plan ID."
        });
    }

    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Retrieve and lock the meal plan before deleting it.
        const [rows] = await connection.query(
            `SELECT MealPlanID, StudentID, MealDate, MealPeriod, MealType,
                    SubmittedVia, ExternalResponseID
             FROM WeeklyMealPlans
             WHERE MealPlanID = ?
             FOR UPDATE`,
            [Number(mealPlanId)]
        );

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Meal plan record not found."
            });
        }

        const mealPlan = rows[0];

        // Record the original details before deletion.
        await connection.query(
            `INSERT INTO AuditLogs
                (UserID, Action, EntityType, EntityID, Details, IPAddress)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.userId,
                "DELETE",
                "WeeklyMealPlan",
                String(mealPlanId),
                JSON.stringify({
                    studentId: mealPlan.StudentID,
                    mealDate: mealPlan.MealDate,
                    mealPeriod: mealPlan.MealPeriod,
                    mealType: mealPlan.MealType,
                    submittedVia: mealPlan.SubmittedVia,
                    externalResponseId: mealPlan.ExternalResponseID
                }),
                req.ip || null
            ]
        );

        // Delete the meal plan.
        await connection.query(
            "DELETE FROM WeeklyMealPlans WHERE MealPlanID = ?",
            [Number(mealPlanId)]
        );

        await connection.commit();

        res.json({
            success: true,
            message: "Meal plan deleted and audit log recorded successfully.",
            mealPlanId: Number(mealPlanId)
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Meal plan rollback error:", rollbackError);
            }
        }

        console.error("Admin meal plan delete error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to delete meal plan."
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});



app.get("/api/admin/audit-logs", requireAdmin, async (req, res) => {
    const {
        action,
        entityType,
        dateFrom,
        dateTo,
        search,
        page = "1",
        limit = "25"
    } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);

    if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
    ) {
        return res.status(400).json({
            success: false,
            message: "Invalid page or limit. Limit must be between 1 and 100."
        });
    }

    const validActions = ["CREATE", "UPDATE", "DELETE"];

    if (action && !validActions.includes(action)) {
        return res.status(400).json({
            success: false,
            message: "Invalid audit action."
        });
    }

    const isValidDate = (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value;

    if (
        (dateFrom && !isValidDate(dateFrom)) ||
        (dateTo && !isValidDate(dateTo))
    ) {
        return res.status(400).json({
            success: false,
            message: "Dates must use the YYYY-MM-DD format."
        });
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
        return res.status(400).json({
            success: false,
            message: "Start date cannot be after end date."
        });
    }

    if (
        search !== undefined &&
        (typeof search !== "string" || search.length > 200)
    ) {
        return res.status(400).json({
            success: false,
            message: "Search text must be 200 characters or fewer."
        });
    }

    try {
        const conditions = [];
        const params = [];

        if (action) {
            conditions.push("a.Action = ?");
            params.push(action);
        }

        if (entityType) {
            conditions.push("a.EntityType = ?");
            params.push(entityType);
        }

        if (dateFrom) {
            conditions.push("a.CreatedAt >= ?");
            params.push(`${dateFrom} 00:00:00`);
        }

        if (dateTo) {
            conditions.push("a.CreatedAt < DATE_ADD(?, INTERVAL 1 DAY)");
            params.push(dateTo);
        }

        if (search && search.trim()) {
            const term = `%${search.trim()}%`;

            conditions.push(`(
                a.EntityID LIKE ?
                OR a.Details LIKE ?
                OR a.Action LIKE ?
                OR a.EntityType LIKE ?
                OR a.ExternalActor LIKE ?
                OR CAST(a.UserID AS CHAR) LIKE ?
            )`);

            params.push(term, term, term, term, term, term);
        }

        const whereClause = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM AuditLogs a
             ${whereClause}`,
            params
        );

        const total = Number(countRows[0].total);
        const totalPages = Math.ceil(total / pageSize);
        const offset = (pageNumber - 1) * pageSize;

        const [logs] = await pool.query(
            `SELECT
                a.AuditLogID,
                a.UserID,
                u.Username,
                a.ExternalActor,
                a.Action,
                a.EntityType,
                a.EntityID,
                a.Details,
                a.IPAddress,
                a.CreatedAt
             FROM AuditLogs a
             LEFT JOIN Users u ON u.UserID = a.UserID
             ${whereClause}
             ORDER BY a.CreatedAt DESC, a.AuditLogID DESC
             LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        );

        res.json({
            success: true,
            logs,
            pagination: {
                page: pageNumber,
                limit: pageSize,
                total,
                totalPages
            }
        });
    } catch (error) {
        console.error("Audit log retrieval error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to retrieve audit logs."
        });
    }
});





// Keep this API local during development.
// Do not expose it directly to the public Internet.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Canteen API running at http://127.0.0.1:${PORT}`);
});
