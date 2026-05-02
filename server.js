const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DATA_FILE = path.join(__dirname, 'data', 'bookings.json');

// ── helpers ──────────────────────────────────────────────────
function loadBookings() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveBookings(bookings) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bookings, null, 2));
}

// ── state ────────────────────────────────────────────────────
let bookings = loadBookings();
let state = {
  barbers: [
    { id: 1, name: 'Ahmad', available: true, currentClient: null },
    { id: 2, name: 'Marcus', available: true, currentClient: null },
    { id: 3, name: 'Zaid',   available: false, currentClient: null },
  ],
  announcement: '',
  isOpen: true,
};

function queueCount() {
  return bookings.filter(b => b.status === 'pending').length;
}
function publicState() {
  return {
    queueCount: queueCount(),
    availableBarbers: state.barbers.filter(b => b.available).length,
    totalBarbers: state.barbers.length,
    announcement: state.announcement,
    isOpen: state.isOpen,
  };
}

// ── middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Uptown-2018add';

// Login page
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uptown Admin — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0A0A0A;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui}
  .box{background:#111;border:1px solid rgba(201,168,76,0.2);padding:48px 40px;width:100%;max-width:360px;text-align:center}
  .logo{font-size:22px;font-weight:700;color:#C9A84C;letter-spacing:0.05em;margin-bottom:8px}
  .sub{font-size:12px;color:#555;margin-bottom:32px;letter-spacing:0.1em;text-transform:uppercase}
  input{width:100%;background:#0A0A0A;border:1px solid rgba(201,168,76,0.15);color:#fff;padding:14px 16px;font-size:14px;outline:none;margin-bottom:12px;transition:border-color 0.2s}
  input:focus{border-color:#C9A84C}
  button{width:100%;padding:14px;background:#C9A84C;color:#0A0A0A;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border:none;cursor:pointer}
  button:hover{background:#e8c96a}
  .error{color:#ff5555;font-size:13px;margin-bottom:16px}
</style>
</head>
<body>
<div class="box">
  <div class="logo">✂ Uptown</div>
  <div class="sub">Admin Access</div>
  ${req.query.error ? '<div class="error">Incorrect password</div>' : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Enter password" autofocus required>
    <button type="submit">Enter Dashboard</button>
  </form>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if ((req.body.password || '').trim() === ADMIN_PASSWORD) {
    res.cookie('admin_auth', 'granted', { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    res.redirect('/admin.html');
  } else {
    res.redirect('/login?error=1');
  }
});

// Protect admin.html
app.use('/admin.html', (req, res, next) => {
  const cookie = req.headers.cookie || '';
  const valid = cookie.split(';').some(c => c.trim() === 'admin_auth=granted');
  if (valid) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// ── REST ─────────────────────────────────────────────────────
app.post('/api/booking', (req, res) => {
  const { name, phone, service, location, date, time, notes } = req.body;
  if (!name || !phone || !service || !location || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const booking = {
    id: uuidv4(),
    name, phone, service, location, date, time,
    notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  saveBookings(bookings);

  // broadcast to admin room and update public queue count
  io.to('admin').emit('new-booking', booking);
  io.emit('state-update', publicState());

  res.json({ success: true, bookingId: booking.id });
});

app.get('/api/state', (req, res) => res.json(publicState()));

// ── socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {

  // immediately send current state
  socket.emit('state-update', publicState());

  // admin joins their room
  socket.on('admin-join', () => {
    socket.join('admin');
    socket.emit('admin-init', { bookings, barbers: state.barbers, state });
  });

  // admin actions
  socket.on('booking-action', ({ id, action }) => {
    const b = bookings.find(x => x.id === id);
    if (!b) return;
    b.status = action; // 'confirmed' | 'declined' | 'completed'
    saveBookings(bookings);
    io.to('admin').emit('booking-updated', b);
    io.emit('booking-status', { id, status: action });
    io.emit('state-update', publicState());
  });

  socket.on('toggle-barber', ({ id }) => {
    const barber = state.barbers.find(b => b.id === id);
    if (barber) {
      barber.available = !barber.available;
      io.emit('state-update', publicState());
      io.to('admin').emit('admin-init', { bookings, barbers: state.barbers, state });
    }
  });

  socket.on('set-announcement', ({ text }) => {
    state.announcement = text;
    io.emit('state-update', publicState());
  });

  socket.on('toggle-open', () => {
    state.isOpen = !state.isOpen;
    io.emit('state-update', publicState());
    io.to('admin').emit('admin-init', { bookings, barbers: state.barbers, state });
  });

  socket.on('clear-bookings', () => {
    bookings = bookings.filter(b => b.status === 'pending');
    saveBookings(bookings);
    io.to('admin').emit('admin-init', { bookings, barbers: state.barbers, state });
  });
});

// ── start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ✂  UPTOWN BARBERSHOP`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Site:   http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin.html\n`);
});
