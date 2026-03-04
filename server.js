require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const path       = require('path');
const mongoose   = require('mongoose');

const Report  = require('./models/Report');
const Counter = require('./models/Counter');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// â”€â”€ Database connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('  âœ”  MongoDB connected'))
  .catch(err => { console.error('  âœ˜  MongoDB connection error:', err.message); process.exit(1); });

// â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// â”€â”€ Pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', (_req, res) => res.render('index'));

app.get('/report', (_req, res) => res.render('report'));

app.get('/dashboard', async (_req, res) => {
  try {
    const reports = await Report.find().sort({ timestamp: -1 }).lean({ virtuals: true });
    res.render('dashboard', { reports });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error loading dashboard');
  }
});

// â”€â”€ API: submit a normal report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/report', async (req, res) => {
  try {
    const seq      = await Counter.nextSeq('report');
    const reportId = `RPT-${String(seq).padStart(4, '0')}`;

    const report = await Report.create({
      reportId,
      ...req.body,
      status:      'new',
      timestamp:   new Date(),
      credibility: computeCredibility(req.body),
      isPanic:     false,
    });

    const payload = report.toJSON();
    io.emit('new-report', payload);
    res.json({ success: true, id: reportId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save report' });
  }
});

// â”€â”€ API: Panic SOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/panic', async (req, res) => {
  try {
    const seq      = await Counter.nextSeq('panic');
    const reportId = SOS-;
    const parsedGps = parseGpsString(req.body.gps);
    let resolvedBarangay = '';
    let resolvedLandmark = '';
    if (parsedGps) {
      const primary = await reverseViaNominatim(parsedGps.lat, parsedGps.lng);
      const fallback = (primary.barangay || primary.landmark)
        ? { barangay: '', landmark: '' }
        : await reverseViaBigDataCloud(parsedGps.lat, parsedGps.lng);
      resolvedBarangay = pickFirst([primary.barangay, fallback.barangay]);
      resolvedLandmark = pickFirst([primary.landmark, fallback.landmark]);
    }
    const report = await Report.create({
      reportId,
      name:          'PANIC ALERT',
      contact:       req.body.contact,
      emergencyType: 'PANIC SOS',
      severity:      'High',
      barangay:      resolvedBarangay || 'Unknown - GPS only',
      landmark:      resolvedLandmark || req.body.gps || 'GPS unavailable',
      street:        '',
      description:   INSTANT PANIC ALERT - Caller needs immediate callback. GPS: ,
      gps:           req.body.gps || '',
      photo:         null,
      status:        'new',
      credibility:   'high',
      isPanic:       true,
      timestamp:     new Date(),
    });
    const payload = report.toJSON();
    io.emit('new-report', payload);
    res.json({ success: true, id: reportId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save panic report' });
  }
});

// â”€â”€ API: update status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.patch('/api/report/:id/status', async (req, res) => {
  try {
    const report = await Report.findOneAndUpdate(
      { reportId: req.params.id },
      { status: req.body.status },
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Not found' });
    io.emit('report-updated', { id: report.reportId, status: report.status });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report' });
  }
});

// â”€â”€ API: delete all reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.delete('/api/reports', async (_req, res) => {
  try {
    await Report.deleteMany({});
    await Counter.deleteMany({});   // reset RPT/SOS counters to 0
    io.emit('reports-cleared');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not clear reports' });
  }
});

// â”€â”€ API: list all reports (JSON) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reports', async (_req, res) => {
  try {
    const reports = await Report.find().sort({ timestamp: -1 }).lean({ virtuals: true });
    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

// â”€â”€ API: reverse geocode GPS to location labels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const primary = await reverseViaNominatim(lat, lng);
    if (primary.barangay || primary.landmark) return res.json(primary);

    const fallback = await reverseViaBigDataCloud(lat, lng);
    return res.json(fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reverse geocode' });
  }
});

// â”€â”€ Helper: credibility score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function computeCredibility({ name, contact, landmark, description, photo, gps }) {
  let score = 0;
  if (name        && name.trim().split(' ').length >= 2) score += 25;
  if (contact     && contact.length >= 11)               score += 20;
  if (landmark    && landmark.length > 5)                score += 20;
  if (description && description.length > 30)            score += 20;
  if (photo)                                             score += 10;
  if (gps)                                               score +=  5;
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function parseGpsString(gps) {
  const s = String(gps || '');
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}function pickFirst(parts) {
  for (const p of parts) {
    if (p && String(p).trim()) return String(p).trim();
  }
  return '';
}

function extractBarangayFromText(text) {
  const s = String(text || '');
  const m = s.match(/(?:\bbrgy\.?\b|\bbarangay\b)\s*([a-z0-9][a-z0-9\s\-]*)/i);
  if (!m || !m[1]) return '';
  return `Barangay ${m[1].trim()}`.replace(/\s+/g, ' ');
}

function normalizeBarangayLabel(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  if (/^brgy\.?/i.test(s)) return s.replace(/^brgy\.?/i, 'Barangay').replace(/\s+/g, ' ').trim();
  return s;
}

async function reverseViaNominatim(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&addressdetails=1&zoom=18`;
  try {
    const data = await httpsGetJson(url, {
      'Accept-Language': 'en',
      'User-Agent': 'Franzolutions/1.0 (Emergency Reporting App)',
    });
    const a = (data && data.address) || {};
    const barangay = normalizeBarangayLabel(
      pickFirst([
        a.barangay,
        extractBarangayFromText(data.display_name),
        extractBarangayFromText(data.name),
        a.suburb,
        a.neighbourhood,
        a.neighborhood,
        a.quarter,
        a.village,
        a.hamlet,
        a.city_district,
      ])
    );
    const landmark = pickFirst([data.name, a.amenity, a.building, a.shop, a.tourism, a.leisure, a.road, a.pedestrian, a.footway]);
    return { barangay, landmark };
  } catch (_e) {
    return { barangay: '', landmark: '' };
  }
}

async function reverseViaBigDataCloud(lat, lng) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=en`;
  try {
    const data = await httpsGetJson(url, {
      'User-Agent': 'Franzolutions/1.0 (Emergency Reporting App)',
    });
    const admins = (data.localityInfo && Array.isArray(data.localityInfo.administrative)) ? data.localityInfo.administrative : [];
    const brgy = admins.find(x => /barangay/i.test(String(x.name || '')));
    const barangay = normalizeBarangayLabel(
      pickFirst([
        brgy && brgy.name,
        extractBarangayFromText(data.locality),
        extractBarangayFromText(data.city),
        data.locality,
        data.city,
        data.principalSubdivision,
      ])
    );
    const landmark = pickFirst([data.locality, data.city, data.principalSubdivision]);
    return { barangay, landmark };
  } catch (_e) {
    return { barangay: '', landmark: '' };
  }
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Request timeout')));
  });
}

// â”€â”€ Socket.IO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
io.on('connection', socket => {
  console.log(`[socket] connected     ${socket.id}`);
  socket.on('disconnect', () => console.log(`[socket] disconnected  ${socket.id}`));
});

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  MDRRMO running on http://localhost:${PORT}`);
  console.log(`  Reporter  â†’  http://localhost:${PORT}/report`);
  console.log(`  Dashboard â†’  http://localhost:${PORT}/dashboard\n`);
});

