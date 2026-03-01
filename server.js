const express = require('express');
const cors = require('cors');
const pool = require('./db'); // เรียกใช้ไฟล์เชื่อมต่อฐานข้อมูล

const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// 📍 API ROUTES (เส้นทางรับส่งข้อมูล)
// ==========================================

// 1. API สำหรับดึงข้อมูลอุปกรณ์ทั้งหมด (แปลงจาก Mock Data เป็นดึงจาก Database)
app.get('/api/assets', async (req, res) => {
    try {
        // สั่ง Query ไปที่ PostgreSQL
        const result = await pool.query('SELECT * FROM assets ORDER BY id ASC');
        res.json(result.rows); // ส่งข้อมูลกลับไปเป็น JSON
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

// ==========================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server backend กำลังรันอยู่ที่ http://localhost:${PORT}`);
});

// 4. API สำหรับเพิ่มอุปกรณ์ใหม่
app.post('/api/assets', async (req, res) => {
    try {
        const { id, name, location, category, frequency } = req.body;
        // ใช้ SQL Insert ข้อมูลลงตาราง assets
        const newAsset = await pool.query(
            "INSERT INTO assets (id, name, location, category, frequency, status, last_check) VALUES ($1, $2, $3, $4, $5, 'normal', NULL) RETURNING *",
            [id, name, location, category, frequency]
        );
        res.json(newAsset.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error: อาจมีรหัสอุปกรณ์ซ้ำในระบบ');
    }
});

// 5. API สำหรับบันทึกผลการตรวจสอบ (Inspection)
app.post('/api/inspect', async (req, res) => {
    const client = await pool.connect(); // ใช้ client เพื่อทำ Transaction
    try {
        const { assetId, status, note, userName } = req.body;
        const logId = `LOG-${Date.now()}`;

        await client.query('BEGIN'); // เริ่มต้น Transaction

        // 1. อัปเดตตาราง assets (เปลี่ยนสถานะ และวันที่ตรวจล่าสุด)
        await client.query(
            "UPDATE assets SET status = $1, last_check = CURRENT_DATE WHERE id = $2",
            [status, assetId]
        );

        // 2. เพิ่มข้อมูลลงตาราง history_logs
        const newLog = await client.query(
            "INSERT INTO history_logs (id, asset_id, action, status, note, user_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [logId, assetId, 'ตรวจสอบอุปกรณ์', status, note, userName]
        );

        await client.query('COMMIT'); // บันทึกทุกอย่างลง DB
        res.json({ success: true, log: newLog.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK'); // ถ้าพัง ให้ยกเลิกทั้งหมด
        console.error(err.message);
        res.status(500).send('Server Error: ไม่สามารถบันทึกผลการตรวจได้');
    } finally {
        client.release();
    }
});

app.delete('/api/assets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM assets WHERE id = $1", [id]);
        res.json({ message: "ลบอุปกรณ์สำเร็จ" });
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

// 6. API สำหรับแก้ไขข้อมูลอุปกรณ์ (Update)
app.put('/api/assets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, location, category, frequency } = req.body;
        
        // ใช้คำสั่ง SQL UPDATE เพื่อแก้ข้อมูลตาม ID
        const updateAsset = await pool.query(
            "UPDATE assets SET name = $1, location = $2, category = $3, frequency = $4 WHERE id = $5 RETURNING *",
            [name, location, category, frequency, id]
        );
        
        if (updateAsset.rows.length === 0) {
            return res.status(404).json({ message: "ไม่พบอุปกรณ์ที่ต้องการแก้ไข" });
        }
        
        res.json(updateAsset.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// ==========================================
// 📍 API สำหรับหน้าตั้งค่า (Settings & Inspectors)
// ==========================================

// 1. จัดการผู้ตรวจสอบ (Inspectors)
app.post('/api/inspectors', async (req, res) => {
    try {
        const { pin, id, name } = req.body;
        const newInsp = await pool.query("INSERT INTO inspectors (pin, id, name) VALUES ($1, $2, $3) RETURNING *", [pin, id, name]);
        res.json(newInsp.rows[0]);
    } catch (err) { res.status(500).send("PIN นี้อาจถูกใช้งานแล้ว"); }
});

app.delete('/api/inspectors/:pin', async (req, res) => {
    try {
        await pool.query("DELETE FROM inspectors WHERE pin = $1", [req.params.pin]);
        res.json({ message: "ลบผู้ตรวจสอบสำเร็จ" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// 2. จัดการการตั้งค่าระบบ (Categories & Checklists)
app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM system_settings");
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.put('/api/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        await pool.query("UPDATE system_settings SET value = $1 WHERE key = $2", [JSON.stringify(value), key]);
        res.json({ message: "อัปเดตการตั้งค่าสำเร็จ" });
    } catch (err) { res.status(500).send("Server Error"); }
});