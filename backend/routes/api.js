// SkillSwap API Client
// All frontend pages import this to talk to the backend

const API_BASE = '/api'; // works both locally and on Railway after deployment

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────
const Auth = {
  getToken:  ()       => localStorage.getItem('ss_token'),
  setToken:  (token)  => localStorage.setItem('ss_token', token),
  getUser:   ()       => JSON.parse(localStorage.getItem('ss_user') || 'null'),
  setUser:   (user)   => localStorage.setItem('ss_user', JSON.stringify(user)),
  logout:    ()       => { localStorage.removeItem('ss_token'); localStorage.removeItem('ss_user'); window.location.href = '/login.html'; },
  isLoggedIn: ()      => !!localStorage.getItem('ss_token'),
};

// ─── BASE FETCH ───────────────────────────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + endpoint, { ...options, headers });
  const data = await res.json();

  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const API = {
  auth: {
    register: (body)  => apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
    login:    (body)  => apiFetch('/auth/login',    { method: 'POST', body: JSON.stringify(body) }),
    me:       ()      => apiFetch('/auth/me'),
  },

  skills: {
    list:        ()         => apiFetch('/skills'),
    addTeach:    (skillId)  => apiFetch('/skills/teach',        { method: 'POST', body: JSON.stringify({ skillId }) }),
    addLearn:    (skillId)  => apiFetch('/skills/learn',        { method: 'POST', body: JSON.stringify({ skillId }) }),
    removeTeach: (skillId)  => apiFetch(`/skills/teach/${skillId}`, { method: 'DELETE' }),
    removeLearn: (skillId)  => apiFetch(`/skills/learn/${skillId}`, { method: 'DELETE' }),
    takeTest:    (skillId)  => apiFetch('/skills/test',         { method: 'POST', body: JSON.stringify({ skillId }) }),
  },

  users: {
    profile:  ()           => apiFetch('/users/me/profile'),
    get:      (id)         => apiFetch(`/users/${id}`),
    browse:   (params = {}) => apiFetch('/users?' + new URLSearchParams(params)),
  },

  matches: {
    list:     ()           => apiFetch('/matches'),
    incoming: ()           => apiFetch('/matches/incoming'),
    propose:  (body)       => apiFetch('/matches', { method: 'POST', body: JSON.stringify(body) }),
    respond:  (id, action) => apiFetch(`/matches/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  },

  sessions: {
    list:     ()     => apiFetch('/sessions'),
    book:     (body) => apiFetch('/sessions',             { method: 'POST',  body: JSON.stringify(body) }),
    complete: (id, body) => apiFetch(`/sessions/${id}/complete`, { method: 'PATCH', body: JSON.stringify(body) }),
    cancel:   (id)   => apiFetch(`/sessions/${id}/cancel`, { method: 'PATCH' }),
  },
};

// ─── UI HELPERS ───────────────────────────────────────────────────────────────

// Show a toast notification
function showToast(message, type = 'success') {
  const existing = document.getElementById('ss-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ss-toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999;
    background: ${type === 'success' ? 'var(--green)' : '#e8855a'};
    color: #fff; padding: 12px 20px; border-radius: 8px;
    font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 500;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    animation: slideUp 0.3s ease;
  `;
  toast.textContent = message;

  const style = document.createElement('style');
  style.textContent = '@keyframes slideUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }';
  document.head.appendChild(style);
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3500);
}

// Redirect to login if not authenticated
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

// Update nav with user name
function initNav() {
  const user = Auth.getUser();
  if (!user) return;

  const navName = document.getElementById('navName');
  if (navName) navName.textContent = user.name.split(' ')[0];

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', Auth.logout);
}
