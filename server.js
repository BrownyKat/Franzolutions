require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const crypto     = require('crypto');
const { Server } = require('socket.io');
const path       = require('path');
const mongoose   = require('mongoose');

const Report      = require('./models/Report');
const Counter     = require('./models/Counter');
const Admin       = require('./models/Admin');
const Dispatcher  = require('./models/Dispatcher');
const AuditLog    = require('./models/AuditLog');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const SESSIONS = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const COOKIE_NAME = 'auth_token';
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'change-me-session-secret');

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of SESSIONS.entries()) {
    if (!session || session.expiresAt < now) SESSIONS.delete(token);
  }
}, 1000 * 60 * 10).unref();

// ── Database connection ──────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('  ✔  MongoDB connected');
    await ensureDefaultAdmin();
  })
  .catch(err => { console.error('  ✘  MongoDB connection error:', err.message); process.exit(1); });

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  const token = getCookie(req, COOKIE_NAME);
  if (!token) return next();
  const now = Date.now();

  let session = SESSIONS.get(token);
  if (session && session.expiresAt < now) {
    SESSIONS.delete(token);
    session = null;
  }

  // Fallback for stateless/serverless deployments (e.g. Vercel),
  // where in-memory sessions are not guaranteed across requests.
  if (!session) {
    session = verifySessionToken(token);
  }
  if (!session || session.expiresAt < now) {
    clearSessionCookie(res);
    return next();
  }

  req.auth = { ...session };
  req.authToken = token;
  res.locals.auth = req.auth;
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Prevent cached protected pages from showing after logout (back button issue).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!req.auth) return res.redirect('/report');
  if (req.auth.role === 'admin') return res.redirect('/admin');
  return res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (req.auth?.role === 'admin') return res.redirect('/admin');
  if (req.auth?.role === 'dispatcher') return res.redirect('/dashboard');
  res.render('login', { error: '' });
});

app.post('/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).render('login', { error: 'Invalid login details.' });
    }
    const admin = await Admin.findOne({ username });
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).render('login', { error: 'Invalid admin credentials.' });
    }
    createSession(req, res, {
      role: 'admin',
      userId: String(admin._id),
      username: admin.username,
      fullName: admin.fullName || admin.username,
    });
    return res.redirect('/admin');
  } catch (err) {
    console.error(err);
    return res.status(500).render('login', { error: 'Login failed. Please try again.' });
  }
});

app.get('/dispatcher/login', (req, res) => {
  if (req.auth?.role === 'admin') return res.redirect('/admin');
  if (req.auth?.role === 'dispatcher') return res.redirect('/dashboard');
  res.render('dispatcher-login', { error: '' });
});

app.post('/dispatcher/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).render('dispatcher-login', { error: 'Invalid login details.' });
    }

    const dispatcher = await Dispatcher.findOne({ username });
    if (!dispatcher || !dispatcher.isActive || !verifyPassword(password, dispatcher.passwordHash)) {
      return res.status(401).render('dispatcher-login', { error: 'Invalid dispatcher credentials.' });
    }

    createSession(req, res, {
      role: 'dispatcher',
      userId: String(dispatcher._id),
      username: dispatcher.username,
      fullName: dispatcher.fullName || dispatcher.username,
    });
    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'LOGIN',
      targetType: 'AUTH',
      targetId: '-',
      details: 'Dispatcher logged in',
    });
    return res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).render('dispatcher-login', { error: 'Login failed. Please try again.' });
  }
});

app.get('/admin/login', (req, res) => {
  return res.redirect('/login');
});

app.post('/admin/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).render('login', { error: 'Invalid login details.' });
    }
    const admin = await Admin.findOne({ username });
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).render('login', { error: 'Invalid admin credentials.' });
    }
    createSession(req, res, {
      role: 'admin',
      userId: String(admin._id),
      username: admin.username,
      fullName: admin.fullName || admin.username,
    });
    return res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).render('login', { error: 'Login failed. Please try again.' });
  }
});

app.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/login');
});

function handleAdminLogout(req, res) {
  destroySession(req, res);
  res.redirect('/login');
}
app.post('/admin/logout', handleAdminLogout);
app.get('/admin/logout', handleAdminLogout);
app.all('/admin/logout', handleAdminLogout);

function handleDispatcherLogout(req, res) {
  destroySession(req, res);
  res.redirect('/dispatcher/login');
}
app.post('/dispatcher/logout', handleDispatcherLogout);
app.get('/dispatcher/logout', handleDispatcherLogout);
app.all('/dispatcher/logout', handleDispatcherLogout);

app.get('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/login');
});

app.get('/report', (_req, res) => res.render('report'));

app.get('/dashboard', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  try {
    const reports = await Report.find().sort({ timestamp: -1 }).lean({ virtuals: true });
    res.render('dashboard', { reports, currentUser: req.auth });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error loading dashboard');
  }
});

app.get('/dispatcher/profile', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  try {
    const dispatcher = await Dispatcher.findById(req.auth.userId).lean();
    if (!dispatcher) return res.redirect('/logout');
    res.render('dispatcher-profile', { dispatcher, error: '', success: '' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load profile');
  }
});

app.post('/dispatcher/profile', requireRolesPage(['dispatcher'], '/dispatcher/login'), async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    const dispatcher = await Dispatcher.findById(req.auth.userId);
    if (!dispatcher) return res.redirect('/logout');

    if (newPassword) {
      if (!currentPassword || !verifyPassword(currentPassword, dispatcher.passwordHash)) {
        return res.status(400).render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: 'Current password is incorrect.', success: '' });
      }
      if (newPassword.length < 6) {
        return res.status(400).render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: 'New password must be at least 6 characters.', success: '' });
      }
      dispatcher.passwordHash = hashPassword(newPassword);
    }

    dispatcher.fullName = fullName;
    dispatcher.phone = phone;
    await dispatcher.save();

    createSession(req, res, {
      role: 'dispatcher',
      userId: String(dispatcher._id),
      username: dispatcher.username,
      fullName: dispatcher.fullName || dispatcher.username,
    });

    await logAudit({
      actorRole: 'dispatcher',
      actorId: String(dispatcher._id),
      actorName: dispatcher.fullName || dispatcher.username,
      action: 'PROFILE_UPDATE',
      targetType: 'DISPATCHER',
      targetId: String(dispatcher._id),
      details: 'Updated dispatcher profile',
    });

    res.render('dispatcher-profile', { dispatcher: dispatcher.toObject(), error: '', success: 'Profile updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update profile');
  }
});

app.get('/admin', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    const { from, to, where } = buildReportDateRangeFilter(req.query.from, req.query.to);
    const dispatchers = await Dispatcher.find().sort({ createdAt: -1 }).lean();
    const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
    const auditLogs = await AuditLog.find({ actorRole: 'dispatcher' }).sort({ timestamp: -1 }).limit(500).lean();
    res.render('admin', {
      dispatchers,
      reports,
      auditLogs,
      stats: {
        totalReports: reports.length,
        activeDispatchers: dispatchers.filter(d => d.isActive).length,
        totalDispatchers: dispatchers.length,
        auditCount: auditLogs.length,
      },
      from,
      to,
      currentUser: req.auth,
      error: String(req.query.err || ''),
      success: String(req.query.ok || ''),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load admin page');
  }
});

app.post('/admin/dispatchers', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return renderAdminPage(req, res, { error: 'Username and password are required.' }, 400);
    }
    if (password.length < 6) {
      return renderAdminPage(req, res, { error: 'Password must be at least 6 characters.' }, 400);
    }
    await Dispatcher.create({
      username,
      fullName,
      phone,
      passwordHash: hashPassword(password),
      isActive: true,
    });
    return res.redirect('/admin?ok=Dispatcher%20created');
  } catch (err) {
    console.error(err);
    const msg = err && err.code === 11000 ? 'Username already exists.' : 'Could not create dispatcher.';
    return renderAdminPage(req, res, { error: msg }, 500);
  }
});

app.post('/admin/dispatchers/:id/update', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    const dispatcher = await Dispatcher.findById(req.params.id);
    if (!dispatcher) return res.redirect('/admin?err=Dispatcher%20not%20found');

    dispatcher.username = String(req.body.username || '').trim();
    dispatcher.fullName = String(req.body.fullName || '').trim();
    dispatcher.phone = String(req.body.phone || '').trim();
    dispatcher.isActive = req.body.isActive === 'on';
    const newPassword = String(req.body.newPassword || '');
    if (newPassword) {
      if (newPassword.length < 6) return res.redirect('/admin?err=Password%20must%20be%20at%20least%206%20characters');
      dispatcher.passwordHash = hashPassword(newPassword);
    }
    await dispatcher.save();
    res.redirect('/admin?ok=Dispatcher%20updated');
  } catch (err) {
    console.error(err);
    const msg = err && err.code === 11000 ? 'Username already exists.' : 'Could not update dispatcher.';
    res.redirect(`/admin?err=${encodeURIComponent(msg)}`);
  }
});

app.post('/admin/dispatchers/:id/delete', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    await Dispatcher.findByIdAndDelete(req.params.id);
    res.redirect('/admin?ok=Dispatcher%20deleted');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?err=Could%20not%20delete%20dispatcher');
  }
});

app.get('/admin/reports/export.xls', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    const { where } = buildReportDateRangeFilter(req.query.from, req.query.to);
    const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
    const html = buildExcelHtml(reports);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports-${stamp}.xls"`);
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not export Excel');
  }
});

app.get('/admin/reports/export.pdf', requireRolesPage(['admin'], '/admin/login'), async (req, res) => {
  try {
    const { from, to, where } = buildReportDateRangeFilter(req.query.from, req.query.to);
    const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
    const lines = [];
    lines.push('MDRRMO REPORT EXPORT');
    lines.push(`Date range: ${from || 'All'} to ${to || 'All'}`);
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push('');
    reports.forEach((r, i) => {
      const line = [
        `${i + 1}.`,
        r.reportId || String(r._id || ''),
        r.emergencyType || '',
        r.status || '',
        r.barangay || '',
        r.landmark || '',
        new Date(r.timestamp).toLocaleString(),
      ].join(' | ');
      lines.push(line.slice(0, 160));
    });
    const pdf = buildSimplePdf(lines);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="reports-${stamp}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not export PDF');
  }
});

// ── API: submit a normal report ──────────────────────────────────────────────
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

// ── API: Panic SOS ───────────────────────────────────────────────────────────
app.post('/api/panic', async (req, res) => {
  try {
    const seq      = await Counter.nextSeq('panic');
    const reportId = `SOS-${String(seq).padStart(4, '0')}`;
    const gps = String(req.body.gps || '').trim();
    let barangay = String(req.body.barangay || '').trim();
    let landmark = String(req.body.landmark || '').trim();
    let street = String(req.body.street || '').trim();

    const coords = parseGpsCoords(gps);
    if (coords && (!barangay || !landmark || !street)) {
      const primary = await reverseViaNominatim(coords.lat, coords.lng);
      let fallback = { barangay: '', landmark: '', street: '' };
      if (!primary.barangay && !primary.landmark && !primary.street) {
        fallback = await reverseViaBigDataCloud(coords.lat, coords.lng);
      }
      barangay = barangay || primary.barangay || fallback.barangay || '';
      landmark = landmark || primary.landmark || fallback.landmark || '';
      street = street || primary.street || fallback.street || '';
    }

    const locationText = pickFirst([
      [street, landmark, barangay].filter(Boolean).join(', '),
      [landmark, barangay].filter(Boolean).join(', '),
      barangay,
      landmark,
      'Location unavailable',
    ]);

    const report = await Report.create({
      reportId,
      name:          'PANIC ALERT',
      contact:       req.body.contact,
      emergencyType: 'PANIC SOS',
      severity:      'High',
      barangay:      barangay || 'Unknown location',
      landmark:      landmark || 'Location unavailable',
      street:        street,
      description:   `INSTANT PANIC ALERT - Caller needs immediate callback. Location: ${locationText}`,
      gps:           gps,
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

// ── API: update status ───────────────────────────────────────────────────────
app.patch('/api/report/:id/status', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const where = reportLookupQuery(req.params.id);
    const report = await Report.findOneAndUpdate(
      where,
      { status: req.body.status },
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Not found' });
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_STATUS_UPDATE',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Set status to ${report.status}`,
    });
    io.emit('report-updated', { id: report.reportId || String(report._id), status: report.status });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report' });
  }
});

// API: update reporter details
app.patch('/api/report/:id/details', requireRolesApi(['dispatcher', 'admin']), async (req, res) => {
  try {
    const allowedFields = ['name', 'contact', 'emergencyType', 'severity', 'barangay', 'landmark', 'street', 'description', 'gps'];
    const updates = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = String(req.body[field] ?? '').trim();
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    const where = reportLookupQuery(req.params.id);
    const current = await Report.findOne(where);
    if (!current) return res.status(404).json({ error: 'Not found' });

    const merged = {
      name: current.name,
      contact: current.contact,
      landmark: current.landmark,
      description: current.description,
      photo: current.photo,
      gps: current.gps,
      ...updates,
    };
    updates.credibility = computeCredibility(merged);

    const report = await Report.findOneAndUpdate(
      where,
      updates,
      { new: true }
    );
    await logAudit({
      actorRole: req.auth.role,
      actorId: req.auth.userId,
      actorName: req.auth.fullName || req.auth.username || '',
      action: 'REPORT_DETAILS_UPDATE',
      targetType: 'REPORT',
      targetId: report.reportId || String(report._id),
      details: `Updated fields: ${Object.keys(updates).join(', ')}`,
    });

    const payload = report.toJSON();
    io.emit('report-details-updated', payload);
    res.json({ success: true, report: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update report details' });
  }
});

// ── API: delete all reports ──────────────────────────────────────────────────
app.delete('/api/reports', requireRolesApi(['dispatcher', 'admin']), async (_req, res) => {
  try {
    const beforeCount = await Report.countDocuments({});
    await Report.deleteMany({});
    await Counter.deleteMany({});   // reset RPT/SOS counters to 0
    await logAudit({
      actorRole: _req.auth.role,
      actorId: _req.auth.userId,
      actorName: _req.auth.fullName || _req.auth.username || '',
      action: 'REPORTS_CLEAR_ALL',
      targetType: 'REPORT',
      targetId: '*',
      details: `Cleared ${beforeCount} reports`,
    });
    io.emit('reports-cleared');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not clear reports' });
  }
});

// ── API: list all reports (JSON) ─────────────────────────────────────────────
app.get('/api/reports', async (_req, res) => {
  try {
    const reports = await Report.find().sort({ timestamp: -1 }).lean({ virtuals: true });
    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

// ── API: reverse geocode GPS to location labels ──────────────────────────────
app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const primary = await reverseViaNominatim(lat, lng);
    if (primary.barangay || primary.landmark || primary.street) return res.json(primary);

    const fallback = await reverseViaBigDataCloud(lat, lng);
    return res.json(fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reverse geocode' });
  }
});

// ── Helper: credibility score ─────────────────────────────────────────────────
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

function pickFirst(parts) {
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

function reportLookupQuery(id) {
  const raw = String(id || '').trim();
  if (!raw) return { reportId: '' };
  if (mongoose.Types.ObjectId.isValid(raw)) {
    return { $or: [{ reportId: raw }, { _id: raw }] };
  }
  return { reportId: raw };
}

function parseGpsCoords(gps) {
  const s = String(gps || '');
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
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
    const street = pickFirst([a.road, a.pedestrian, a.footway, a.path, a.cycleway, a.neighbourhood, a.neighborhood]);
    return { barangay, landmark, street };
  } catch (_e) {
    return { barangay: '', landmark: '', street: '' };
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
    const street = pickFirst([data.locality, data.city, data.principalSubdivision]);
    return { barangay, landmark, street };
  } catch (_e) {
    return { barangay: '', landmark: '', street: '' };
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

function getCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw) return '';
  const parts = raw.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function createSession(req, res, payload) {
  const currentToken = req.authToken || getCookie(req, COOKIE_NAME);
  if (currentToken) SESSIONS.delete(currentToken);
  const token = signSessionToken(payload);
  const session = { ...payload, expiresAt: Date.now() + SESSION_TTL_MS };
  SESSIONS.set(token, session);
  res.cookie(COOKIE_NAME, token, {
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

function destroySession(req, res) {
  const token = req.authToken || getCookie(req, COOKIE_NAME);
  if (token) SESSIONS.delete(token);
  clearSessionCookie(res);
}

function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const base = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base.length % 4)) % 4;
  return Buffer.from(base + '='.repeat(padLen), 'base64').toString('utf8');
}

function signSessionToken(payload) {
  const body = toBase64Url(JSON.stringify({
    role: payload.role,
    userId: payload.userId,
    username: payload.username,
    fullName: payload.fullName,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (_e) {
    return null;
  }
  try {
    const data = JSON.parse(fromBase64Url(body));
    if (!data || !data.role || !data.userId || !data.expiresAt) return null;
    if (Number(data.expiresAt) < Date.now()) return null;
    return {
      role: data.role,
      userId: data.userId,
      username: data.username || '',
      fullName: data.fullName || data.username || '',
      expiresAt: Number(data.expiresAt),
    };
  } catch (_e) {
    return null;
  }
}

function requireRolesPage(roles, loginPath = '/dispatcher/login') {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.redirect(loginPath);
    next();
  };
}

function requireRolesApi(roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, oldHash] = String(stored || '').split(':');
  if (!salt || !oldHash) return false;
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(oldHash, 'hex'));
  } catch (_e) {
    return false;
  }
}

async function ensureDefaultAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const password = String(process.env.ADMIN_PASSWORD || 'admin123');
  const fullName = String(process.env.ADMIN_FULLNAME || 'System Administrator').trim();
  const existing = await Admin.findOne({ username }).lean();
  if (existing) return;
  await Admin.create({ username, fullName, passwordHash: hashPassword(password) });
  console.log(`  ✔  Default admin created (${username})`);
}

function buildReportDateRangeFilter(fromRaw, toRaw) {
  const from = String(fromRaw || '').trim();
  const to = String(toRaw || '').trim();
  const where = {};
  const ts = {};

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const d = new Date(`${from}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) ts.$gte = d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const d = new Date(`${to}T23:59:59.999Z`);
    if (!Number.isNaN(d.getTime())) ts.$lte = d;
  }
  if (Object.keys(ts).length) where.timestamp = ts;
  return { from, to, where };
}

async function renderAdminPage(req, res, options = {}, statusCode = 200) {
  const { from, to, where } = buildReportDateRangeFilter(req.query.from, req.query.to);
  const dispatchers = await Dispatcher.find().sort({ createdAt: -1 }).lean();
  const reports = await Report.find(where).sort({ timestamp: -1 }).lean({ virtuals: true });
  const auditLogs = await AuditLog.find({ actorRole: 'dispatcher' }).sort({ timestamp: -1 }).limit(500).lean();
  return res.status(statusCode).render('admin', {
    dispatchers,
    reports,
    auditLogs,
    stats: {
      totalReports: reports.length,
      activeDispatchers: dispatchers.filter(d => d.isActive).length,
      totalDispatchers: dispatchers.length,
      auditCount: auditLogs.length,
    },
    from,
    to,
    currentUser: req.auth,
    error: options.error || '',
    success: options.success || '',
  });
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildExcelHtml(reports) {
  const rows = reports.map(r => {
    return `<tr>
      <td>${escHtml(r.reportId || r._id)}</td>
      <td>${escHtml(r.emergencyType)}</td>
      <td>${escHtml(r.status)}</td>
      <td>${escHtml(r.severity)}</td>
      <td>${escHtml(r.name)}</td>
      <td>${escHtml(r.contact)}</td>
      <td>${escHtml(r.barangay)}</td>
      <td>${escHtml(r.landmark)}</td>
      <td>${escHtml(r.street)}</td>
      <td>${escHtml(new Date(r.timestamp).toLocaleString())}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <table border="1">
    <thead>
      <tr><th>ID</th><th>Type</th><th>Status</th><th>Severity</th><th>Name</th><th>Contact</th><th>Barangay</th><th>Landmark</th><th>Street</th><th>Timestamp</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;
}

function pdfEscapeText(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildSimplePdf(lines) {
  const safeLines = (Array.isArray(lines) ? lines : []).slice(0, 500);
  const contentLines = ['BT', '/F1 10 Tf', '40 800 Td', '12 TL'];
  safeLines.forEach((line, idx) => {
    const txt = pdfEscapeText(line).slice(0, 220);
    contentLines.push(`(${txt}) Tj`);
    if (idx !== safeLines.length - 1) contentLines.push('T*');
  });
  contentLines.push('ET');
  const stream = contentLines.join('\n');
  const streamLen = Buffer.byteLength(stream, 'utf8');

  const objs = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  objs.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objs.push(`5 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += o;
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objs.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'utf8');
}

async function logAudit(entry) {
  try {
    if (!entry) return;
    await AuditLog.create({
      actorRole: String(entry.actorRole || ''),
      actorId: String(entry.actorId || ''),
      actorName: String(entry.actorName || ''),
      action: String(entry.action || ''),
      targetType: String(entry.targetType || ''),
      targetId: String(entry.targetId || ''),
      details: String(entry.details || ''),
      timestamp: new Date(),
    });
  } catch (e) {
    console.error('[audit] failed to write log:', e && e.message ? e.message : e);
  }
}

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[socket] connected     ${socket.id}`);
  socket.on('disconnect', () => console.log(`[socket] disconnected  ${socket.id}`));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  MDRRMO running on http://localhost:${PORT}`);
  console.log(`  Reporter        -> http://localhost:${PORT}/report`);
  console.log(`  Dispatcher      -> http://localhost:${PORT}/dispatcher/login`);
  console.log(`  Admin           -> http://localhost:${PORT}/admin/login`);
  console.log(`  Dispatcher UI   -> http://localhost:${PORT}/dashboard`);
  console.log(`  Admin Console   -> http://localhost:${PORT}/admin\n`);
});
