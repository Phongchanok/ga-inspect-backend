const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); // 🌟 สำคัญ

const webpush = require('web-push');

// ตั้งค่า VAPID Keys ให้กับ web-push
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

// เช็คว่ามีคีย์ครบไหม ถ้าครบให้เซ็ตค่า
if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:test@example.com',
        vapidPublicKey,
        vapidPrivateKey
    );
}

// 🌟 สร้าง Pool ให้รองรับทั้ง Render และ Localhost
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ==========================================
// 📝 ฟังก์ชันผู้ช่วย: บันทึก Audit Log อัตโนมัติ
// ==========================================
const createAuditLog = async (username, action, detail) => {
    try {
        await pool.query(
            "INSERT INTO audit_logs (username, action, detail) VALUES ($1, $2, $3)",
            [username, action, detail]
        );
    } catch (err) {
        console.error("❌ สร้าง Audit Log ไม่สำเร็จ:", err.message);
    }
};

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 📍 ระบบยืนยันตัวตน (Authentication)
// ==========================================

// 1. API สำหรับ Login ของ Admin และ Editor
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    // เช็คสิทธิ์ Super Admin (ลบได้)
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        const token = jwt.sign(
            { role: 'admin', user: username }, 
            process.env.JWT_SECRET, 
            { expiresIn: '8h' }
        );
        return res.json({ success: true, token: token, role: 'admin', message: "เข้าสู่ระบบ Super Admin" });
    } 
    // เช็คสิทธิ์ Editor (ลบไม่ได้)
    else if (username === process.env.EDITOR_USER && password === process.env.EDITOR_PASS) {
        const token = jwt.sign(
            { role: 'editor', user: username }, 
            process.env.JWT_SECRET, 
            { expiresIn: '8h' }
        );
        return res.json({ success: true, token: token, role: 'editor', message: "เข้าสู่ระบบ Staff" });
    } 
    // 🌟 เช็คสิทธิ์ Manager (ดูได้อย่างเดียว)
    else if (username === process.env.MANAGER_USER && password === process.env.MANAGER_PASS) {
        const token = jwt.sign(
            { role: 'manager', user: username }, 
            process.env.JWT_SECRET, 
            { expiresIn: '8h' }
        );
        return res.json({ success: true, token: token, role: 'manager', message: "เข้าสู่ระบบระดับ Manager" });
    } 
    // ถ้ารหัสไม่ตรงเลย
    else {
        return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง" });
    }
});

// 2. Middleware สำหรับล็อคประตู API (เช็ค Token)
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 

    if (!token) {
        return res.status(403).json({ message: "ไม่มีสิทธิ์เข้าถึง: กรุณาแนบ Token" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(401).json({ message: "ไม่มีสิทธิ์เข้าถึง: Token ไม่ถูกต้องหรือหมดอายุ" });
        }
        req.user = user; 
        next(); 
    });
};

// ==========================================
// 📍 API ROUTES (เส้นทางรับส่งข้อมูล)
// ==========================================

// --- API แบบเปิด (ไม่ต้องมี Token เพราะ Inspector และหน้า Dashboard ต้องใช้) ---

// 1. API สำหรับดึงข้อมูลอุปกรณ์ทั้งหมด
app.get('/api/assets', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM assets ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// 2. API สำหรับดึงประวัติการตรวจสอบ
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM history_logs ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// 3. API สำหรับดึงรายชื่อผู้ตรวจสอบ
app.get('/api/inspectors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM inspectors');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// 5. API สำหรับบันทึกผลการตรวจสอบ (Inspection) (เปิดไว้ให้ Inspector ที่มีแค่ PIN ใช้ได้)
app.post('/api/inspect', async (req, res) => {
    const client = await pool.connect(); 
    try {
        const { assetId, status, note, userName } = req.body;
        const logId = `LOG-${Date.now()}`;

        await client.query('BEGIN'); 

        await client.query(
            "UPDATE assets SET status = $1, last_check = CURRENT_DATE WHERE id = $2",
            [status, assetId]
        );

        const newLog = await client.query(
            "INSERT INTO history_logs (id, asset_id, action, status, note, user_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [logId, assetId, 'ตรวจสอบอุปกรณ์', status, note, userName]
        );

        await client.query('COMMIT'); 
        res.json({ success: true, log: newLog.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error(err.message);
        res.status(500).send('Server Error: ไม่สามารถบันทึกผลการตรวจได้');
    } finally {
        client.release();
    }
});

// ดึงการตั้งค่าระบบ (เปิดไว้ให้ Inspector ดึง Checklists ไปโชว์ตอนสแกน)
app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM system_settings");
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});


// --- 🔒 API แบบปิด (เฉพาะ Admin ที่ต้อง Login และมี Token ถึงจะใช้ได้) ---

// 4. API สำหรับเพิ่มอุปกรณ์ใหม่ 
app.post('/api/assets', verifyAdminToken, async (req, res) => {
    // 🌟 ด่านตรวจ: ถ้าเป็น Manager ให้เด้งออกทันที (ห้ามเพิ่มข้อมูล)
    if (req.user.role === 'manager') {
        return res.status(403).json({ message: "ปฏิเสธการเข้าถึง: สิทธิ์ Manager ดูข้อมูลได้อย่างเดียว" });
    }

    try {
        const { id, name, location, category, frequency } = req.body;
        const newAsset = await pool.query(
            "INSERT INTO assets (id, name, location, category, frequency, status, last_check) VALUES ($1, $2, $3, $4, $5, 'normal', NULL) RETURNING *",
            [id, name, location, category, frequency]
        );

        // 🌟 เพิ่มบรรทัดนี้: จด Log ทันทีที่บันทึก Database สำเร็จ!
        await createAuditLog(req.user.user, "ADD_ASSET", `เพิ่มอุปกรณ์ใหม่: ${id} (${name})`);
        
        res.json(newAsset.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error: อาจมีรหัสอุปกรณ์ซ้ำในระบบ');
    }
});

// 6. API สำหรับลบอุปกรณ์ (ล็อค 2 ชั้น: ต้องมี Token และ ต้องเป็น admin)
app.delete('/api/assets/:id', verifyAdminToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: "ปฏิเสธการเข้าถึง: คุณไม่มีสิทธิ์ลบข้อมูล" });
    }

    try {
        const { id } = req.params;
        await pool.query("DELETE FROM assets WHERE id = $1", [id]);
        
        // 🌟 จด Log: การลบอุปกรณ์
        await createAuditLog(req.user.user, "DELETE_ASSET", `ลบอุปกรณ์รหัส: ${id} ออกจากระบบ`);
        
        res.json({ message: "ลบอุปกรณ์สำเร็จ" });
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

// 7. API สำหรับแก้ไขข้อมูลอุปกรณ์ (Update)
app.put('/api/assets/:id', verifyAdminToken, async (req, res) => { 
    if (req.user.role === 'manager') {
        return res.status(403).json({ message: "ปฏิเสธการเข้าถึง: คุณมีสิทธิ์เพียงแค่ดูข้อมูลเท่านั้น" });
    }

    try {
        // เพิ่มบรรทัดนี้หลังเช็คสิทธิ์ Manager
        const { id } = req.params;
        const { name, location, category, frequency } = req.body; // 🌟 เพิ่มบรรทัดนี้

        const updateAsset = await pool.query(
            "UPDATE assets SET name = $1, location = $2, category = $3, frequency = $4 WHERE id = $5 RETURNING *",
            [name, location, category, frequency, id]
        );
        
        if (updateAsset.rows.length === 0) {
            return res.status(404).json({ message: "ไม่พบอุปกรณ์ที่ต้องการแก้ไข" });
        }

        // 🌟 จด Log: การแก้ไขอุปกรณ์ (ย้ายมาไว้ข้างใน try หลังจากอัปเดตสำเร็จ)
        await createAuditLog(req.user.user, "EDIT_ASSET", `แก้ไขข้อมูลอุปกรณ์: ${id}`);
        
        res.json(updateAsset.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// 8. API สำหรับดึงประวัติการใช้งานระบบ (Audit Logs)
app.get('/api/audit-logs', verifyAdminToken, async (req, res) => {
    // 🌟 ให้สิทธิ์เฉพาะ Admin และ Manager ดูได้ (Staff ดูไม่ได้)
    if (req.user.role === 'editor') {
        return res.status(403).json({ message: "ปฏิเสธการเข้าถึง: คุณไม่มีสิทธิ์ดูประวัติการใช้งาน" });
    }

    try {
        // ดึงข้อมูล 100 รายการล่าสุด
        const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// ==========================================
// 📍 API สำหรับหน้าตั้งค่า (Settings & Inspectors)
// ==========================================

// 1. จัดการผู้ตรวจสอบ (Inspectors)
app.post('/api/inspectors', verifyAdminToken, async (req, res) => { 
    if (req.user.role === 'manager') return res.status(403).json({ message: "ปฏิเสธการเข้าถึง" });
    try {
        const { pin, id, name } = req.body;
        const newInsp = await pool.query("INSERT INTO inspectors (pin, id, name) VALUES ($1, $2, $3) RETURNING *", [pin, id, name]);
        
        // 🌟 จด Log: เพิ่ม Inspector
        await createAuditLog(req.user.user, "ADD_INSPECTOR", `เพิ่มรายชื่อผู้ตรวจสอบ: ${name}`);
        
        res.json(newInsp.rows[0]);
    } catch (err) { res.status(500).send("PIN นี้อาจถูกใช้งานแล้ว"); }
});

app.delete('/api/inspectors/:pin', verifyAdminToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: "ปฏิเสธการเข้าถึง: คุณไม่มีสิทธิ์ลบข้อมูล" });
    }

    try {
        await pool.query("DELETE FROM inspectors WHERE pin = $1", [req.params.pin]);
        
        // 🌟 จด Log: ลบ Inspector
        await createAuditLog(req.user.user, "DELETE_INSPECTOR", `ลบผู้ตรวจสอบ PIN: ${req.params.pin}`);
        
        res.json({ message: "ลบผู้ตรวจสอบสำเร็จ" });
    } catch (err) { 
        res.status(500).send("Server Error"); 
    }
});

// 2. จัดการการตั้งค่าระบบ (Categories & Checklists)
app.put('/api/settings/:key', verifyAdminToken, async (req, res) => {
    if (req.user.role === 'manager') return res.status(403).json({ message: "ปฏิเสธการเข้าถึง" });
    try {
        const { key } = req.params;
        const { value } = req.body;
        await pool.query("UPDATE system_settings SET value = $1 WHERE key = $2", [JSON.stringify(value), key]);
        
        // 🌟 จด Log: แก้ไขตั้งค่า
        await createAuditLog(req.user.user, "UPDATE_SETTINGS", `อัปเดตการตั้งค่า: ${key}`);
        
        res.json({ message: "อัปเดตการตั้งค่าสำเร็จ" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// ==========================================
// 📍 API สำหรับ Push Notification
// ==========================================

// เอาโค้ดส่วนนี้ไปวางต่อจากบรรทัดที่ 330
app.get('/api/cron/daily-summary', async (req, res) => {
    try {
        await sendDailySummary(); // เรียกใช้ฟังก์ชัน
        res.status(200).send("ส่งแจ้งเตือนงานค้างสำเร็จ");
    } catch (err) {
        console.error("Cron Error:", err);
        res.status(500).send("เกิดข้อผิดพลาดในการส่งแจ้งเตือน");
    }
});

// 🌟 Route สำหรับรับข้อมูล Subscription จากมือถือช่าง
app.post('/api/subscribe', async (req, res) => {
    const subscription = req.body;
    try {
        // บันทึกลง Database ของจริงที่เราเพิ่งสร้างตารางไป
        await pool.query(
            'INSERT INTO push_subscriptions (subscription_data) VALUES ($1)',
            [subscription]
        );
        res.status(201).json({ message: "Success: ข้อมูลแจ้งเตือนถูกเก็บลง Database แล้ว!" });
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ error: "ไม่สามารถบันทึกข้อมูลลงฐานข้อมูลได้" });
    }
});

// 🌟 Route สำหรับทดสอบยิง Push Notification (อัปเดตใหม่ ให้ทนทานต่อ Error)
app.get('/api/test-push', async (req, res) => {
    const payload = JSON.stringify({
        title: "🚨 มีงานแจ้งซ่อมใหม่!",
        body: "กรุณาตรวจสอบหน้า Dashboard",
        icon: "/icon-192.png",
        badge: "/icon-192.png"
    });

    let successCount = 0;
    let failCount = 0;

    try {
        // 🌟 ดึงข้อมูลจาก Database แทนตัวแปร
        const subs = await pool.query("SELECT id, subscription_data FROM push_subscriptions");
        
        for (let row of subs.rows) {
            try {
                await webpush.sendNotification(JSON.parse(row.subscription_data), payload);
                successCount++;
            } catch (error) {
                failCount++;
                if (error.statusCode === 410 || error.statusCode === 404) {
                    // ลบออกจาก Database ทันทีถ้ารหัสตาย
                    await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
                }
            }
        }
        res.send(`<h1>ยิงแจ้งเตือนเสร็จสิ้น! (ดึงจาก DB)</h1> <p>สำเร็จ: ${successCount}, ล้มเหลวและลบ: ${failCount}</p>`);
    } catch (dbErr) {
        res.status(500).send("Database Error");
    }
});

// ฟังก์ชันสำหรับส่งแจ้งเตือนสรุปงานเช้า
async function sendDailySummary() {
    const today = new Date().toISOString().split('T')[0];
    
    // 🌟 ดึงเฉพาะอุปกรณ์ที่ (ยังไม่เคยตรวจ) หรือ (ครบกำหนด/เลยกำหนดแล้ว)
    // หมายเหตุ: เช็คตัวพิมพ์เล็ก/ใหญ่ของคำว่า 'normal' ให้ตรงกับตอนที่ Insert ด้วยนะครับ
    const query = `
        SELECT COUNT(*) FROM assets 
        WHERE (last_check IS NULL OR (last_check + (frequency || ' days')::interval) <= $1)
        AND status != 'normal' 
    `;
    
    try {
        const result = await pool.query(query, [today]);
        const count = parseInt(result.rows[0].count);

        if (count > 0) {
            const payload = JSON.stringify({
                title: "📋 รายการตรวจเช็คอุปกรณ์วันนี้",
                body: `วันนี้มีอุปกรณ์ที่ถึงกำหนดตรวจสอบทั้งหมด ${count} รายการครับ`,
                icon: "/icon-192.png"
            });
            
            const subs = await pool.query("SELECT subscription_data FROM push_subscriptions");
            subs.rows.forEach(s => {
                webpush.sendNotification(JSON.parse(s.subscription_data), payload).catch(e => console.error(e));
            });
            console.log(`ส่งแจ้งเตือนงานเช้า ${count} รายการ สำเร็จ`);
        }
    } catch (err) {
        console.error("เกิดข้อผิดพลาดในการคำนวณงานเช้า:", err);
    }
}

// ==========================================
// 📍 START SERVER (ต้องอยู่ล่างสุดเสมอ)
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server backend กำลังรันอยู่ที่ http://localhost:${PORT}`);
});