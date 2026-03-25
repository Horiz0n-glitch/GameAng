import './style.css';
import { db } from './firebase.js';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  updateDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
  deleteDoc
} from 'firebase/firestore';
import { storage, auth, googleProvider } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';

// ---- CUSTOM NOTIFICATION SYSTEM ----
// Replaces all native alert() and confirm() with in-app notifications

function showToast(msg, type = 'info', duration = 3000) {
  const t = document.getElementById('toast');
  if (!t) return;
  // Icons per type
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  t.textContent = `${icons[type] || ''} ${msg}`;
  t.className = 'toast show toast-' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function showAlert(msg, type = 'info') {
  return new Promise((resolve) => {
    const container = document.getElementById('modal-container');
    if (!container) { console.warn(msg); resolve(); return; }
    const icons = { info: 'ℹ️', success: '🎉', error: '🚨', warning: '⚠️' };
    const colors = { info: 'var(--accent1)', success: 'var(--accent4)', error: 'var(--accent3)', warning: 'var(--accent5)' };
    container.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div style="text-align:center; margin-bottom:16px; font-size:2.5rem">${icons[type] || '💬'}</div>
        <p style="text-align:center; font-size:1rem; line-height:1.5; color:var(--text); margin-bottom:24px">${msg}</p>
        <div class="modal-actions" style="justify-content:center">
          <button class="btn btn-primary" id="modal-ok-btn" style="background:${colors[type] || 'var(--accent1)'}; min-width:100px">Aceptar</button>
        </div>
      </div>
    `;
    container.classList.add('open');
    const okBtn = document.getElementById('modal-ok-btn');
    const close = () => { container.classList.remove('open'); container.innerHTML = ''; resolve(); };
    okBtn.addEventListener('click', close);
    okBtn.focus();
    // Close on overlay click
    container.addEventListener('click', (e) => { if (e.target === container) close(); }, { once: true });
    // Close on Escape
    const keyHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', keyHandler); } };
    document.addEventListener('keydown', keyHandler);
  });
}

function showConfirm(msg, { confirmText = 'Confirmar', cancelText = 'Cancelar', type = 'warning' } = {}) {
  return new Promise((resolve) => {
    const container = document.getElementById('modal-container');
    if (!container) { resolve(false); return; }
    const icons = { warning: '⚠️', danger: '🗑️', info: 'ℹ️' };
    const btnColors = { warning: 'var(--accent5)', danger: 'var(--accent3)', info: 'var(--accent1)' };
    container.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div style="text-align:center; margin-bottom:16px; font-size:2.5rem">${icons[type] || '❓'}</div>
        <p style="text-align:center; font-size:1rem; line-height:1.5; color:var(--text); margin-bottom:8px">${msg}</p>
        <p style="text-align:center; font-size:0.82rem; color:var(--muted); margin-bottom:24px">Esta acción no se puede deshacer.</p>
        <div class="modal-actions" style="justify-content:center; gap:12px">
          <button class="btn btn-secondary" id="modal-cancel-btn" style="min-width:100px">${cancelText}</button>
          <button class="btn btn-primary" id="modal-confirm-btn" style="background:${btnColors[type]}; min-width:100px">${confirmText}</button>
        </div>
      </div>
    `;
    container.classList.add('open');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    const close = (result) => { container.classList.remove('open'); container.innerHTML = ''; resolve(result); };
    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    cancelBtn.focus();
    container.addEventListener('click', (e) => { if (e.target === container) close(false); }, { once: true });
    const keyHandler = (e) => { if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', keyHandler); } };
    document.addEventListener('keydown', keyHandler);
  });
}

// --- STATE ---
let state = {
  role: 'none',   // 'none', 'profe', 'alumno'
  currentPage: 'landing',
  quizzes: [],
  activeQuiz: null,
  session: null,   // { id, code, quizId, status, currentQ, ... }
  players: [],
  playerScore: 0,
  selectedPlayerDetail: null,
  localQIndex: 0, // Individual progress for automatic mode
  timeLeft: 0,
  timerInterval: null,
  defaultBg: '/bg-default.png',
  user: null,
  showingFeedback: false,
  autoNextTimeout: null
};

// --- ROUTER ---
function setPage(pageId) {
  state.currentPage = pageId;
  render();
}

function render() {
  const content = document.getElementById('main-content');
  const navActions = document.getElementById('nav-actions');
  const avatar = document.getElementById('user-avatar');
  const bgOverlay = document.getElementById('bg-overlay');

  // Update Background based on quiz or default
  const quizBg = state.activeQuiz?.bgUrl || state.defaultBg;
  if (bgOverlay) bgOverlay.style.backgroundImage = `url('${quizBg}')`;

  // Nav Actions
  navActions.innerHTML = '';
  if (state.role === 'profe' && state.user) {
    navActions.innerHTML = `
      <button class="nav-tab ${state.currentPage === 'home' ? 'active' : ''}" onclick="window.router.go('home')">Inicio</button>
      <button class="nav-tab ${state.currentPage === 'creator' ? 'active' : ''}" onclick="window.router.go('creator')">Crear Quiz</button>
      <button class="nav-tab" onclick="window.actions.logout()">Cerrar Sesión</button>
    `;
    avatar.innerHTML = `<img src="${state.user.photoURL}" style="width:100%; border-radius:50%" />`;
    avatar.title = state.user.displayName;
  } else if (state.role === 'alumno') {
    avatar.textContent = (state.playerName || '?').charAt(0).toUpperCase();
    avatar.title = state.playerName || 'Alumno';
  }

  // Dynamic Content
  switch (state.currentPage) {
    case 'landing':
      content.innerHTML = renderLanding();
      break;
    case 'home':
      content.innerHTML = renderHome();
      break;
    case 'creator':
      content.innerHTML = renderCreator();
      break;
    case 'lobby':
      content.innerHTML = renderLobby();
      break;
    case 'play':
      content.innerHTML = renderPlay();
      break;
    case 'results':
      content.innerHTML = renderResults();
      break;
    case 'join':
      content.innerHTML = renderJoin();
      break;
    default:
      content.innerHTML = '<h1>404 Not Found</h1>';
  }
}

// --- VIEWS ---
function renderLanding() {
  return `
    <div class="page active">
      <div style="text-align:center; margin-bottom: 40px">
        <h1 class="home-greeting">Bienvenido a <span>QuizMaster Online</span></h1>
        <p style="color:var(--muted)">Elegí cómo querés entrar hoy</p>
      </div>
      <div class="landing-grid">
        <div class="role-card" onclick="window.actions.selectRole('profe')">
          <div class="role-icon">👨‍🏫</div>
          <div class="role-title">Soy Profe</div>
          <p class="role-desc">Crea quizzes, organiza partidas y mira los resultados en tiempo real.</p>
          <button class="btn btn-primary" style="width:100%; justify-content:center">Administrar →</button>
        </div>
        <div class="role-card" onclick="window.actions.selectRole('alumno')">
          <div class="role-icon">🎓</div>
          <div class="role-title">Soy Alumno</div>
          <p class="role-desc">Unite a una partida con el código que te dio tu profe y empezá a jugar.</p>
          <button class="btn btn-secondary" style="width:100%; justify-content:center">Unirme →</button>
        </div>
      </div>
    </div>
  `;
}

function renderHome() {
  const qCount = state.quizzes.length;
  return `
    <div class="page active">
      <div class="home-header">
        <div>
          <p style="color:var(--muted);font-size:.9rem;margin-bottom:4px">Panel del Profe 👋</p>
          <div class="home-greeting">Mis <span>Quizzes Online</span></div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn btn-secondary" onclick="window.actions.newTFQuiz()">✅ Verdadero o Falso</button>
          <button class="btn btn-primary" onclick="window.actions.newQuiz()">＋ Nuevo Quiz</button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Mis Quizzes</div><div class="stat-val">${qCount}</div></div>
        <div class="stat-card"><div class="stat-label">Feedback Real-time</div><div class="stat-val">ON</div></div>
        <div class="stat-card"><div class="stat-label">Enlace Directo</div><div class="stat-val">🔗</div></div>
      </div>
      <div class="section-title">Quizzes disponibles <span class="badge badge-purple">${qCount}</span></div>
      <div class="quiz-grid">
        ${qCount === 0 ? `
          <div class="empty-state">
            <div class="emoji">🎯</div>
            <p>Todavía no creaste ningún quiz online.</p>
            <button class="btn btn-primary" onclick="window.actions.newQuiz()">Crear mi primer quiz</button>
          </div>
        ` : state.quizzes.map((q, i) => `
          <div class="quiz-card">
            <div class="quiz-card-color" style="background:${q.color || '#6c63ff'}"></div>
            <div class="quiz-card-title">${q.name}</div>
            <div class="quiz-card-meta">${q.questions.length} preguntas · ${q.timePerQ || 20}s por pregunta</div>
            <div class="quiz-card-actions">
              <button class="btn btn-primary" onclick="window.actions.manageSession(${i})">🚀 Iniciar / Monitorear</button>
              <button class="btn btn-secondary" onclick="window.actions.editQuiz(${i})">✏ Editar</button>
              <button class="btn btn-danger" onclick="window.actions.deleteQuiz(${i})">🗑</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCreator() {
  const isEditing = state.editingQuizIdx !== null;
  return `
    <div class="page active">
      <div class="creator-header">
        <button class="btn btn-secondary" onclick="window.router.go('home')">← Volver</button>
        <h2>${isEditing ? 'Editar Quiz' : 'Nuevo Quiz Online'}</h2>
        <div style="margin-left:auto; display:flex; gap:10px">
          <button class="btn btn-primary" onclick="window.actions.saveQuiz()">Guardar en Firebase</button>
        </div>
      </div>
      <div class="creator-layout">
        <div class="creator-sidebar">
          <div class="form-group">
            <label class="form-label">Nombre del Quiz *</label>
            <input class="form-input" id="qz-name" value="${state.activeQuiz?.name || ''}" placeholder="Ej: Historia Argentina" oninput="window.actions.updateQuizMeta('name', this.value)" />
          </div>
          <div class="form-group">
            <label class="form-label">Tiempo por pregunta (seg)</label>
            <select class="form-select" id="qz-time" onchange="window.actions.updateQuizMeta('timePerQ', this.value)">
              <option value="10" ${state.activeQuiz?.timePerQ == 10 ? 'selected' : ''}>10 segundos</option>
              <option value="20" ${state.activeQuiz?.timePerQ == 20 || !state.activeQuiz ? 'selected' : ''}>20 segundos</option>
              <option value="30" ${state.activeQuiz?.timePerQ == 30 ? 'selected' : ''}>30 segundos</option>
              <option value="60" ${state.activeQuiz?.timePerQ == 60 ? 'selected' : ''}>60 segundos</option>
              <option value="0" ${state.activeQuiz?.timePerQ == 0 ? 'selected' : ''}>Sin límite</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Imagen de Fondo</label>
            <div style="display:flex; gap:8px; margin-bottom:8px">
              <input type="file" id="bg-file-input" style="display:none" accept="image/*" onchange="window.actions.uploadBgFile(this)" />
              <button class="btn btn-secondary" onclick="document.getElementById('bg-file-input').click()" style="padding:8px 12px; font-size:0.75rem">📁 Seleccionar PC</button>
              <input class="form-input" id="qz-bg" value="${state.activeQuiz?.bgUrl || ''}" placeholder="O pegá URL..." style="flex:1" oninput="window.actions.updateQuizMeta('bgUrl', this.value)" onchange="window.actions.updateBg(this.value)" />
            </div>
            <p style="font-size:0.75rem; color:var(--muted)">Sube una de tu pc o pega el enlace arriba.</p>
          </div>
          <hr style="border:none; border-top:1px solid var(--border); margin:16px 0">
          <button class="btn btn-secondary" onclick="window.actions.addQuestion()" style="width:100%; justify-content:center">＋ Agregar pregunta</button>
        </div>
        <div class="creator-main" id="q-container">
          ${!state.activeQuiz?.questions?.length ? `
            <div class="empty-state">
              <div class="emoji">❓</div>
              <p>Agregá tu primera pregunta</p>
              <button class="btn btn-primary" onclick="window.actions.addQuestion()">＋ Agregar ahora</button>
            </div>
          ` : state.activeQuiz.questions.map((q, qi) => `
            <div class="question-card">
              <div class="question-num">
                Pregunta ${qi + 1}
                <button class="btn btn-danger" onclick="window.actions.removeQuestion(${qi})" style="padding:4px 10px;font-size:.75rem">✕</button>
              </div>
              <input class="form-input" placeholder="Pregunta..." value="${q.text || ''}" oninput="window.actions.updateQ(${qi}, 'text', this.value)" />
              <div class="options-grid">
                ${q.options.map((opt, oi) => `
                  <div class="option-row">
                    <input class="form-input" value="${opt || ''}" placeholder="Opción ${String.fromCharCode(65+oi)}..." oninput="window.actions.updateOpt(${qi}, ${oi}, this.value)" />
                    <input type="checkbox" ${Array.isArray(q.correct) && q.correct.includes(oi) ? 'checked' : ''} onchange="window.actions.toggleCorrect(${qi}, ${oi})">
                    ${q.options.length > 2 ? `<button class="btn btn-danger" onclick="window.actions.removeOpt(${qi}, ${oi})" style="padding:4px 8px; font-size:0.7rem">✕</button>` : ''}
                  </div>
                `).join('')}
              </div>
              <div style="display:flex; gap:10px; margin-top:15px">
                <button class="add-option-btn" style="flex:1; margin-top:0" onclick="window.actions.addOpt(${qi})">＋ Agregar opción</button>
                <button class="add-option-btn" style="flex:1; margin-top:0; border-style:dotted" onclick="window.actions.toggleNoteField(${qi})">
                  ${q.note || q.showNoteField ? '✕ Ocultar nota' : '📝 Agregar nota'}
                </button>
              </div>

              ${(q.note || q.showNoteField) ? `
                <div class="note-field-wrap">
                  <div class="note-field-label">
                    <span>💡 Nota explicativa</span> Solo aparece cuando el alumno responde.
                  </div>
                  <textarea class="form-textarea" placeholder="Ej: Esta respuesta es correcta porque..." oninput="window.actions.updateQNote(${qi}, this.value)">${q.note || ''}</textarea>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderJoin() {
  const urlParams = new URLSearchParams(window.location.search);
  const directCode = urlParams.get('session');
  
  return `
    <div class="page active">
      <div class="join-wrap">
        <div style="font-size:3rem;margin-bottom:12px">🎮</div>
        <h2>¡A jugar!</h2>
        <p>${directCode ? `Preparado para entrar al juego` : 'Ingresá el código que te dio tu profe'}</p>
        
        ${directCode ? `
          <div class="badge badge-purple" style="font-size:1.2rem; padding:10px 20px; margin-bottom:20px">${directCode}</div>
          <input type="hidden" id="join-code" value="${directCode}" />
        ` : `
          <div class="form-group">
            <input class="form-input code-input" id="join-code" placeholder="CÓDIGO" maxlength="6" oninput="this.value=this.value.toUpperCase()" />
          </div>
        `}
        
        <div class="form-group">
          <input class="form-input" id="join-name" placeholder="Tu nombre" style="text-align:center" onkeyup="if(event.key==='Enter') window.actions.joinSession()" autofocus />
        </div>
        <button class="btn btn-primary" onclick="window.actions.joinSession()" style="width:100%;justify-content:center;padding:14px">Entrar al juego →</button>
        <button class="btn btn-secondary" onclick="window.router.go('landing')" style="width:100%;margin-top:10px;justify-content:center">← Volver</button>
      </div>
    </div>
  `;
}

function renderLobby() {
  const isProfe = state.role === 'profe';
  const sessionUrl = `${window.location.origin}${window.location.pathname}?session=${state.session.code}`;
  
  return `
    <div class="page active">
      <div class="lobby-card">
        <p style="color:var(--muted);font-size:.88rem;margin-bottom:4px">Código de partida</p>
        <div class="game-code">${state.session.code}</div>
        <p style="color:var(--muted);font-size:.9rem">${isProfe ? 'Compartí este código o el enlace con tus alumnos' : 'Esperando que el profe inicie...'}</p>
        ${isProfe ? `
          <div style="margin:20px 0;display:flex;gap:10px;justify-content:center">
            <button class="btn btn-secondary" onclick="window.actions.copyLink('${sessionUrl}')">📋 Copiar Enlace</button>
          </div>
        ` : ''}
        <div class="section-title" style="justify-content:center">
          Jugadores conectados <span class="badge badge-green">${state.players.length}</span>
        </div>
        <div class="players-list">
          ${state.players.map(p => `
            <div class="player-chip" style="position:relative">
              <div class="player-dot"></div>
              ${p.name}
              ${isProfe ? `<button onclick="window.actions.deletePlayer('${p.name}')" title="Eliminar" style="background:none; border:none; margin-left:6px; color:#ff6b6b; cursor:pointer; font-size:1rem; display:flex; align-items:center; justify-content:center; padding:0">✕</button>` : ''}
            </div>
          `).join('')}
        </div>
        ${isProfe ? `
          <button class="btn btn-primary" onclick="window.actions.startPlay()" style="margin-top:20px;width:100%;justify-content:center;padding:14px" ${state.players.length === 0 ? 'disabled' : ''}>
            Iniciar juego →
          </button>
        ` : `
          <div style="margin-top:20px; font-weight:600; color:var(--accent1)">Juego cargado: ${state.activeQuiz.name}</div>
        `}
      </div>
    </div>
  `;
}

function renderPlay() {
  const isProfe = state.role === 'profe';
  
  if (isProfe && !state.isPreview) {
    // Profe sees real-time overview
    return `
      <div class="page active">
        <div class="home-header">
          <div>
            <div class="home-greeting">Monitoreo: <span style="font-size:1.5rem">${state.session.code}</span></div>
            <p style="color:var(--muted)">Los alumnos están jugando a su propio ritmo.</p>
          </div>
          <div style="display:flex; gap:10px">
            <button class="btn btn-secondary" onclick="window.actions.copyLink('${window.location.origin}${window.location.pathname}?session=${state.session.code}')">📋 Link</button>
            <button class="btn btn-outline-primary" onclick="window.actions.startPreview()">👀 Previsualizar</button>
            <button class="btn btn-outline-secondary" onclick="window.actions.endSession()">🏠 Salir</button>
          </div>
        </div>
        
        <div class="section-title">Progreso de la clase</div>
        <div class="leaderboard">
          <div class="lb-header" style="display:flex; padding:10px; font-size:0.8rem; color:var(--muted); font-weight:700">
            <div style="width:40px">#</div>
            <div style="flex:1">Jugador</div>
            <div style="width:100px; text-align:center">Progreso</div>
            <div style="width:80px; text-align:right">Puntaje</div>
          </div>
          ${state.players.sort((a,b) => b.score - a.score).map((p, i) => `
            <div class="lb-row" style="cursor:pointer" onclick="window.actions.viewPlayerDetail('${p.name}')">
              <div class="lb-rank">${i+1}</div>
              <div class="lb-name" style="display:flex; align-items:center; gap:8px">
                <button class="btn-del" onclick="event.stopPropagation(); window.actions.deletePlayer('${p.name}')" title="Eliminar información">🗑</button>
                <span>${p.name} <span style="font-size:0.75rem; color:var(--accent1); margin-left:5px">🔍 Ver respuestas</span></span>
              </div>
              <div style="width:100px; text-align:center">
                <span class="badge ${p.finished ? 'badge-purple' : 'badge-green'}">
                  ${p.finished ? 'Terminado' : `Q${(p.qProgress || 0) + 1}`}
                </span>
              </div>
              <div style="width:80px; text-align:right; font-weight:700">
                ${p.score} pts
              </div>
            </div>
          `).join('')}
        </div>

        ${state.selectedPlayerDetail ? (() => {
          const p = state.players.find(pl => pl.name === state.selectedPlayerDetail);
          if (!p) return '';
          const totalQs = state.activeQuiz.questions.length;
          return `
            <div class="modal-overlay open" onclick="window.actions.closePlayerDetail()">
              <div class="modal" style="max-width:600px; width:95%; max-height:85vh; overflow-y:auto" onclick="event.stopPropagation()">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px">
                  <h3 style="margin:0">Respuestas de ${p.name}</h3>
                  <button class="btn btn-secondary" style="padding:5px 10px" onclick="window.actions.closePlayerDetail()">Cerrar</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:12px">
                  ${state.activeQuiz.questions.map((q, idx) => {
                    const resp = p.responses?.[idx];
                    const isCorrect = resp?.isCorrect;
                    const chosen = resp?.chosen || [];
                    const correctIndices = Array.isArray(q.correct) ? q.correct : [q.correct];
                    
                    return `
                      <div style="border:1px solid var(--border); border-radius:12px; padding:15px; background:${resp ? (isCorrect ? '#f0fff9' : '#fff0f0') : '#f8f8f8'}">
                        <div style="font-weight:700; font-size:0.9rem; margin-bottom:8px; color:var(--muted)">
                          Pregunta ${idx + 1} ${resp ? (isCorrect ? '✅ Correcta' : '❌ Incorrecta') : '⏳ Sin responder'}
                        </div>
                        <div style="font-weight:600; margin-bottom:10px">${q.text}</div>
                        
                        <div style="font-size:0.85rem">
                          <div style="margin-bottom:5px">
                            <b>Respuesta del alumno:</b> 
                            ${chosen.length > 0 ? chosen.map(c => q.options[c]).join(', ') : '<span style="color:var(--muted)">Sin respuesta</span>'}
                          </div>
                          <div style="color:${isCorrect ? '#1a9e75' : '#c0392b'}">
                            <b>Respuesta correcta:</b> ${correctIndices.map(c => q.options[c]).join(', ')}
                          </div>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            </div>
          `;
        })() : ''}
      </div>
    `;
  }

  // Preview view for Teacher
  if (state.isPreview) {
    return `
      <div class="page active" style="padding:15px">
        <div style="background:var(--accent1); color:white; padding:15px 20px; border-radius:12px; margin-bottom:24px; display:flex; justify-content:space-between; align-items:center; box-shadow:var(--shadow)">
          <div style="display:flex; align-items:center; justify-content:start; gap:10px">
            <span style="font-size:1.5rem">👀</span>
            <div>
              <h2 style="margin:0; font-size:1.1rem; font-weight:800; font-family:'Plus Jakarta Sans', sans-serif">MODO PREVISUALIZACIÓN</h2>
              <p style="margin:0; font-size:0.8rem; opacity:0.9">Vista estática con las respuestas correctas resaltadas.</p>
            </div>
          </div>
          <button class="btn" style="background:rgba(255,255,255,0.2); color:white; padding:8px 16px; font-size:0.85rem; border:none; cursor:pointer;" onclick="window.actions.backToMonitor()">Volver al Monitoreo</button>
        </div>
        
        <div class="play-screen" style="max-width:800px; margin:0 auto; padding-bottom:40px;">
          ${state.activeQuiz.questions.map((q, qIndex) => `
            <div style="background:var(--white); border-radius:var(--radius); padding:25px; margin-bottom:20px; box-shadow:var(--shadow); border:1px solid var(--border);">
              <div class="q-header" style="margin-bottom:15px">
                <span class="q-counter" style="font-weight:700; color:var(--muted)">Pregunta ${qIndex + 1} / ${state.activeQuiz.questions.length}</span>
              </div>
              <div class="q-text" style="font-size:1.2rem; font-weight:700; margin-bottom:20px">${q.text}</div>
              <div class="answers-grid">
                ${q.options.map((opt, i) => {
                  const isCorrect = Array.isArray(q.correct) ? q.correct.includes(i) : q.correct === i;
                  const btnStyle = isCorrect ? 'background:#e0fff5; border-color:var(--accent4); color:#1a9e75;' : 'background:var(--white); border-color:var(--border); color:var(--text); opacity:0.6;';
                  return `
                    <div style="padding:15px 20px; border-radius:var(--radius-sm); border:2px solid ${isCorrect ? 'var(--accent4)' : 'var(--border)'}; ${btnStyle} display:flex; align-items:center; gap:12px; font-weight:500;">
                      <div class="option-letter ${['opt-a','opt-b','opt-c','opt-d','opt-e','opt-f','opt-g','opt-h'][i]}">${String.fromCharCode(65+i)}</div>
                      ${opt || `Opción ${i+1}`}
                      ${isCorrect ? '<span style="margin-left:auto; font-size:1.1rem">✅</span>' : ''}
                    </div>
                  `;
                }).join('')}
              </div>
              
              ${q.note ? `
                <div class="answer-note" style="margin-top:20px; box-shadow:none">
                  <span class="note-icon">📝</span>
                  <div style="text-align:left">
                    <div style="font-weight:700; font-size:0.75rem; text-transform:uppercase; color:var(--accent5); margin-bottom:4px">Nota post-respuesta:</div>
                    ${q.note}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Student view 
  if (state.role === 'alumno') {
    const total = state.activeQuiz.questions.length;
    const qIndex = state.localQIndex;
    
    if (qIndex >= total) {
      const sorted = [...state.players].sort((a,b) => b.score - a.score);
      return `
        <div class="page active">
          <div class="results-card">
            <div style="font-size:3.5rem; margin-bottom:15px">🏁</div>
            <h2>¡Quiz Completado!</h2>
            <p style="color:var(--muted); margin-bottom:24px">Mirá cómo va el tablero en tiempo real:</p>
            
            <div class="leaderboard">
              ${sorted.map((p, i) => `
                <div class="lb-row ${p.name === state.playerName ? 'highlight' : ''}">
                  <div class="lb-rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</div>
                  <div class="lb-name">
                    ${p.name} ${p.name === state.playerName ? '<span class="badge badge-purple">Tú</span>' : ''}
                    ${p.finished ? ' ✅' : ' ⏳'}
                  </div>
                  <div class="lb-bar"><div class="lb-bar-fill" style="width:${total > 0 ? Math.round(((p.score||0)/total)*100) : 0}%"></div></div>
                  <div class="lb-score">${p.score || 0}/${total}</div>
                </div>
              `).join('')}
            </div>

            <div style="margin-top:30px">
              <button class="btn btn-secondary" onclick="window.router.go('landing')">🏠 Salir al inicio</button>
            </div>
          </div>
        </div>
      `;
    }

  const q = state.activeQuiz.questions[qIndex];
  const player = state.players.find(p => p.name === state.playerName);
  const currentAnswers = player?.currentAnswer || [];
  
  return `
    <div class="page active">
      <div class="play-screen">
        <div class="q-header">
          <span class="q-counter">Pregunta ${qIndex + 1} / ${total}</span>
          <div class="timer-ring ${state.timeLeft < 5 ? 'emergency' : ''}">${state.activeQuiz.timePerQ > 0 ? state.timeLeft : '∞'}</div>
        </div>
        <div class="q-text" key="${qIndex}">${q.text}</div>
        <p style="color:var(--muted); font-size:0.85rem; margin-bottom:15px">
          Seleccioná la respuesta correcta
        </p>
        <div class="answers-grid">
          ${q.options.map((opt, i) => {
            const isSelected = currentAnswers.includes(i);
            const isActuallyCorrect = q.correct.includes(i);
            let feedbackClass = '';
            if (isSelected) {
              feedbackClass = isActuallyCorrect ? 'correct' : 'wrong';
            }
            return `
              <button class="answer-btn ${feedbackClass}" 
                ${(currentAnswers.length > 0 && !state.showingFeedback) || state.showingFeedback ? 'disabled' : ''}
                onclick="window.actions.selectStudentAnswer(${i})">
                <div class="option-letter ${['opt-a','opt-b','opt-c','opt-d','opt-e','opt-f','opt-g','opt-h'][i]}">${String.fromCharCode(65+i)}</div>
                ${opt || `Opción ${i+1}`}
              </button>
            `;
          }).join('')}
        </div>
        <div style="margin-top:24px; text-align:center">
          ${state.showingFeedback && q.note ? `
            <div class="answer-note">
              <span class="note-icon">📝</span>
              <div style="text-align:left">${q.note}</div>
            </div>
          ` : ''}

          ${state.showingFeedback ? `
            <button class="game-btn" onclick="window.actions.proceedToNext()" style="width:100%; margin-top:20px">
              ${qIndex === total - 1 ? 'Ver Resultados Finales →' : 'Siguiente Pregunta →'}
            </button>
          ` : `
            <button class="game-btn" onclick="window.actions.submitAnswer()" style="width:100%" ${currentAnswers.length === 0 ? 'disabled' : ''}>
              Confirmar Respuesta ✔
            </button>
          `}
        </div>
      </div>
    </div>
    `;
  }

  return '<div class="page active">Cargando...</div>';
}

function renderResults() {
  const total = state.activeQuiz.questions.length;
  const sorted = [...state.players].sort((a,b) => b.score - a.score);
  
  return `
    <div class="page active">
      <div class="results-card">
        <div class="results-header">
          <div style="font-size:2.5rem">🏆</div>
          <h2 style="font-family:'Syne',sans-serif;font-weight:800;font-size:1.6rem;margin:8px 0">Podio Final: ${state.activeQuiz.name}</h2>
        </div>
        <div class="leaderboard">
          ${sorted.map((p, i) => `
            <div class="lb-row">
              <div class="lb-rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</div>
              <div class="lb-name" style="display:flex; align-items:center; gap:8px">
                ${state.role === 'profe' ? `<button class="btn-del" onclick="window.actions.deletePlayer('${p.name}')" title="Eliminar información">🗑</button>` : ''}
                <span>${p.name} ${state.playerName && p.name === state.playerName ? '<span class="badge badge-purple">Tú</span>' : ''}</span>
              </div>
              <div class="lb-bar"><div class="lb-bar-fill" style="width:${total > 0 ? Math.round(((p.score||0)/total)*100) : 0}%"></div></div>
              <div class="lb-score">${p.score || 0}/${total}</div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:24px;justify-content:center">
          <button class="btn btn-primary" onclick="window.router.go('landing')">🏠 Salir</button>
        </div>
      </div>
    </div>
  `;
}

// --- LOGIC ---
window.actions = {
  selectRole: async (role) => {
    state.role = role;
    if (role === 'profe') {
      if (!state.user) {
        await window.actions.loginWithGoogle();
      } else {
        window.actions.loadQuizzes();
        setPage('home');
      }
    } else {
      setPage('join');
    }
  },

  loginWithGoogle: async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      state.user = result.user;
      state.role = 'profe';
      await window.actions.loadQuizzes();
      setPage('home');
    } catch (e) {
      console.error(e);
      await showAlert('Error al iniciar sesión con Google. Intentá de nuevo.', 'error');
    }
  },

  logout: async () => {
    await signOut(auth);
    state.user = null;
    state.role = 'none';
    setPage('landing');
  },
  
  loadQuizzes: async () => {
    if (!state.user) return;
    const q = query(collection(db, 'quizzes'), where('userId', '==', state.user.uid));
    const qSnap = await getDocs(q);
    state.quizzes = qSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    render();
  },

  updateBg: (url) => {
    const bg = url || state.defaultBg;
    const el = document.getElementById('bg-overlay');
    if (el) el.style.backgroundImage = `url('${bg}')`;
    if (state.activeQuiz) state.activeQuiz.bgUrl = url;
  },

  uploadBgFile: async (input) => {
    const file = input.files[0];
    if (!file) return;
    
    try {
      input.disabled = true;
      const fileName = `backgrounds/${Date.now()}-${file.name}`;
      const storageRef = ref(storage, fileName);
      
      const snap = await uploadBytes(storageRef, file);
      const url = await getDownloadURL(snap.ref);
      
      window.actions.updateBg(url);
      document.getElementById('qz-bg').value = url;
      showToast('Imagen subida correctamente!', 'success');
    } catch (e) {
      console.error(e);
      await showAlert('Error al subir la imagen. Verificá los permisos de Firebase Storage.', 'error');
    } finally {
      input.disabled = false;
    }
  },

  updateQuizMeta: (field, val) => {
    if (!state.activeQuiz) return;
    if (field === 'timePerQ') val = parseInt(val) || 0;
    state.activeQuiz[field] = val;
  },

  newQuiz: () => {
    state.editingQuizIdx = null;
    state.activeQuiz = { name: '', timePerQ: 20, questions: [], color: '#6c63ff', bgUrl: '' };
    setPage('creator');
  },

  newTFQuiz: () => {
    state.editingQuizIdx = null;
    state.activeQuiz = { 
        name: 'Nuevo Verdadero o Falso', 
        timePerQ: 20, 
        questions: [
            { text: '', options: ['Verdadero', 'Falso'], correct: [0] },
            { text: '', options: ['Verdadero', 'Falso'], correct: [0] },
            { text: '', options: ['Verdadero', 'Falso'], correct: [0] }
        ], 
        color: '#43d9ad', 
        bgUrl: '' 
    };
    setPage('creator');
  },

  editQuiz: (idx) => {
    state.editingQuizIdx = idx;
    state.activeQuiz = JSON.parse(JSON.stringify(state.quizzes[idx]));
    setPage('creator');
  },

  deleteQuiz: async (idx) => {
    const ok = await showConfirm(`¿Eliminar "${state.quizzes[idx].name}" de la nube?`, {
      confirmText: '🗑 Eliminar',
      cancelText: 'Cancelar',
      type: 'danger'
    });
    if (ok) {
      await deleteDoc(doc(db, 'quizzes', state.quizzes[idx].id));
      showToast('Quiz eliminado correctamente', 'success');
      window.actions.loadQuizzes();
    }
  },

  addQuestion: () => {
    state.activeQuiz.questions.push({ text: '', options: ['', '', '', ''], correct: [0], note: '', showNoteField: false });
    render();
  },

  removeQuestion: (qi) => {
    state.activeQuiz.questions.splice(qi, 1);
    render();
  },

  addOpt: (qi) => {
    if (state.activeQuiz.questions[qi].options.length >= 8) { showToast('Máximo 8 opciones permitidas', 'warning'); return; }
    state.activeQuiz.questions[qi].options.push('');
    render();
  },

  removeOpt: (qi, oi) => {
    state.activeQuiz.questions[qi].options.splice(oi, 1);
    // Cleanup correct choices
    state.activeQuiz.questions[qi].correct = state.activeQuiz.questions[qi].correct
      .filter(idx => idx !== oi)
      .map(idx => idx > oi ? idx - 1 : idx);
    render();
  },

  updateQ: (qi, field, val) => {
    state.activeQuiz.questions[qi][field] = val;
  },

  updateOpt: (qi, oi, val) => {
    state.activeQuiz.questions[qi].options[oi] = val;
  },

  toggleCorrect: (qi, oi) => {
    if (!Array.isArray(state.activeQuiz.questions[qi].correct)) {
      state.activeQuiz.questions[qi].correct = [0];
    }
    const idx = state.activeQuiz.questions[qi].correct.indexOf(oi);
    if (idx > -1) {
      // Don't allow 0 correct answers? Or maybe yes.
      if (state.activeQuiz.questions[qi].correct.length > 1) {
        state.activeQuiz.questions[qi].correct.splice(idx, 1);
      }
    } else {
      state.activeQuiz.questions[qi].correct.push(oi);
    }
    render();
  },

  updateQNote: (qi, val) => {
    state.activeQuiz.questions[qi].note = val;
  },

  toggleNoteField: (qi) => {
    const q = state.activeQuiz.questions[qi];
    q.showNoteField = !q.showNoteField;
    render();
  },

  saveQuiz: async () => {
    if (!state.activeQuiz?.name?.trim()) { await showAlert('El nombre del quiz es obligatorio.', 'warning'); return; }
    state.activeQuiz.userId = state.user.uid;

    try {
      let quizId;
      if (state.editingQuizIdx !== null) {
        quizId = state.quizzes[state.editingQuizIdx].id;
        await updateDoc(doc(db, 'quizzes', quizId), state.activeQuiz);
      } else {
        const docRef = await addDoc(collection(db, 'quizzes'), state.activeQuiz);
        quizId = docRef.id;
        state.activeQuiz.id = quizId; // Add ID to state before adding to list if needed
      }
      showToast('Quiz guardado en Firebase!', 'success', 3000);
      
      // Load all quizzes first to ensure the index is correct or just find the quiz index
      await window.actions.loadQuizzes();
      const newIdx = state.quizzes.findIndex(q => q.id === quizId);
      if (newIdx > -1) {
        await window.actions.manageSession(newIdx);
        window.actions.startPreview();
      } else {
        window.actions.selectRole('profe');
      }
    } catch (e) {
      console.error(e);
      await showAlert('Error al guardar el quiz en Firebase. Revisá tu conexión.', 'error');
    }
  },

  manageSession: async (idx) => {
    const quiz = state.quizzes[idx];
    
    // Find if there's any session for this quiz (current or past)
    const q = query(collection(db, 'sessions'), where('quizId', '==', quiz.id));
    const snap = await getDocs(q);
    
    let session;
    if (snap.empty) {
      // Sessions are always created in 'playing' state — no teacher initiation needed
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      session = { 
        code, 
        quizId: quiz.id, 
        status: 'playing', 
        currentQIndex: 0, 
        createdAt: serverTimestamp() 
      };
      await setDoc(doc(db, 'sessions', code), session);
      session.id = code;
    } else {
      const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      session = sessions.sort((a, b) => {
          const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
          const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
          return tB - tA;
      })[0];

      // If session is finished, create a new one to keep it always available
      if (session.status === 'finished') {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        session = { 
          code, 
          quizId: quiz.id, 
          status: 'playing', 
          currentQIndex: 0, 
          createdAt: serverTimestamp() 
        };
        await setDoc(doc(db, 'sessions', code), session);
        session.id = code;
      }
    }
    
    state.session = session;
    state.activeQuiz = quiz;
    
    // Listen to players
    onSnapshot(collection(db, 'sessions', session.id, 'players'), (snap) => {
      state.players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    });

    setPage('play'); // Monitoring view for Profe
  },

  joinSession: async () => {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const name = document.getElementById('join-name').value.trim();
    if (!code) { await showAlert('Ingresá el código de la partida.', 'warning'); return; }
    if (!name) { await showAlert('Ingresá tu nombre para unirte.', 'warning'); return; }

    const sessSnap = await getDoc(doc(db, 'sessions', code));
    if (!sessSnap.exists()) { await showAlert('Código inválido. Pedile el código correcto al profe.', 'error'); return; }

    const sessionData = sessSnap.data();
    // No more status === 'finished' check — game is always available!
    
    // Bug #11 fix: check for duplicate player names
    const playerRef = doc(db, 'sessions', code, 'players', name);
    const existingPlayer = await getDoc(playerRef);
    if (existingPlayer.exists()) {
      await showAlert(`Ya hay un jugador con el nombre "${name}". Elegí otro nombre.`, 'warning');
      return;
    }

    state.session = { id: code, ...sessionData };
    state.playerName = name;
    state.role = 'alumno';
    
    // Load quiz data
    const qSnap = await getDoc(doc(db, 'quizzes', state.session.quizId));
    state.activeQuiz = qSnap.data();

    // Register player
    await setDoc(playerRef, { name, score: 0, currentAnswer: [], responses: {}, qProgress: 0, finished: false });

    // Listen to session changes
    onSnapshot(doc(db, 'sessions', code), (sn) => {
      const data = sn.data();
      const prevStatus = state.session?.status;
      state.session = { id: code, ...data };
      
      // Automatic start if session is already playing
      if (data.status === 'playing' && state.currentPage === 'lobby') {
        state.localQIndex = 0;
        window.actions.startTimer();
        setPage('play');
      }
      // No more data.status === 'finished' listener for students — progress is individual
      
      render();
    });

    // Listen to players (for results)
    onSnapshot(collection(db, 'sessions', code, 'players'), (snap) => {
      state.players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    });

    // Go directly to play if session is already active — no lobby wait needed
    state.localQIndex = 0;
    if (state.session.status === 'playing') {
      window.actions.startTimer();
      setPage('play');
    } else {
      // Fallback: session is waiting (shouldn't happen with auto-play, but just in case)
      setPage('lobby');
    }
  },

  startPlay: async () => {
    await updateDoc(doc(db, 'sessions', state.session.id), { status: 'playing' });
    window.actions.startTimer();
    setPage('play');
  },

  startPlayerPlay: () => {
    state.localQIndex = 0;
    window.actions.startTimer();
    setPage('play');
  },

  startTimer: () => {
    window.actions.stopTimer();
    if (!state.activeQuiz || state.activeQuiz.timePerQ <= 0) return;
    
    state.timeLeft = state.activeQuiz.timePerQ;
    state.timerInterval = setInterval(() => {
      state.timeLeft--;
      if (state.timeLeft <= 0) {
        window.actions.submitAnswer(); // Auto-submit when time is up
      } else {
        render();
      }
    }, 1000);
    render();
  },

  stopTimer: () => {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
  },

  selectStudentAnswer: async (idx) => {
    let player = state.players.find(p => p.name === state.playerName);
    if (!player.currentAnswer) player.currentAnswer = [];
    
    // If already answered this question, don't allow change
    if (player.currentAnswer.length > 0) return;
    if (player.qProgress !== state.localQIndex) return;

    player.currentAnswer = [idx];
    render();

    // Sync immediately to Firebase so the choice is locked in the cloud too
    const playerRef = doc(db, 'sessions', state.session.id, 'players', state.playerName);
    await updateDoc(playerRef, { currentAnswer: [idx] });
  },

  submitAnswer: async () => {
    window.actions.stopTimer();
    const total = state.activeQuiz.questions.length;
    const q = state.activeQuiz.questions[state.localQIndex];

    const playerRef = doc(db, 'sessions', state.session.id, 'players', state.playerName);
    const player = state.players.find(p => p.name === state.playerName);
    const chosen = player?.currentAnswer || [];
    
    // Check correctness: grant point if chosen option is among the correct ones
    const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
    const isCorrect = chosen.length > 0 && 
                      chosen.every(val => correctArr.includes(val));
    
    let newScore = (player?.score || 0);
    if (isCorrect) newScore++;

    // Update progress state
    const answeredQIndex = state.localQIndex;
    const isFinished = (answeredQIndex + 1) >= total;

    // Show feedback locally
    state.showingFeedback = true;
    render();

    // Sync to DB
    await updateDoc(playerRef, {
      [`responses.${answeredQIndex}`]: { 
        chosen: chosen,
        isCorrect: isCorrect,
        answeredAt: serverTimestamp()
      },
      currentAnswer: [], 
      score: newScore,
      // qProgress remains at current index until proceedToNext
    });
    
    // If it was the last question, we can mark as finished in DB now
    if (isFinished) {
      await updateDoc(playerRef, { finished: true });
    }

    // Auto-advance after a delay (4s if has note, 2s if not)
    clearTimeout(state.autoNextTimeout);
    state.autoNextTimeout = setTimeout(() => {
      if (state.currentPage === 'play' && state.showingFeedback) {
        window.actions.proceedToNext();
      }
    }, q.note ? 4000 : 2000);
  },

  proceedToNext: async () => {
    clearTimeout(state.autoNextTimeout);
    state.localQIndex++;
    state.showingFeedback = false;
    
    // Sync progress to DB when moving to next question or finishing
    const playerRef = doc(db, 'sessions', state.session.id, 'players', state.playerName);
    await updateDoc(playerRef, { qProgress: state.localQIndex });
    
    const isFinished = state.localQIndex >= state.activeQuiz.questions.length;
    if (!isFinished) {
      window.actions.startTimer();
    }
    render();
  },

  nextQuestion: async () => {
    // Reset players currentAnswer for next Q
    const playersSnap = await getDocs(collection(db, 'sessions', state.session.id, 'players'));
    const batch = playersSnap.docs.map(d => updateDoc(d.ref, { currentAnswer: null }));
    await Promise.all(batch);

    await updateDoc(doc(db, 'sessions', state.session.id), {
      currentQIndex: state.session.currentQIndex + 1
    });
  },

  endSession: async () => {
    // Just return home. Don't set status: 'finished' globally so the quiz stays available.
    state.session = null;
    state.activeQuiz = null;
    state.players = [];
    state.isPreview = false;
    setPage('home');
  },

  startPreview: () => {
    state.isPreview = true;
    render();
  },

  backToMonitor: () => {
    state.isPreview = false;
    render();
  },

  viewPlayerDetail: (name) => {
    state.selectedPlayerDetail = name;
    render();
  },

  closePlayerDetail: () => {
    state.selectedPlayerDetail = null;
    render();
  },

  copyLink: (url) => {
    navigator.clipboard.writeText(url).then(() => showToast('📋 Enlace copiado al portapapeles!', 'success'));
  },

  deletePlayer: async (name) => {
    const ok = await showConfirm(`¿Eliminar la información de "${name}"?`, {
      confirmText: '🗑 Eliminar',
      cancelText: 'Cancelar',
      type: 'danger'
    });
    if (ok) {
      try {
        await deleteDoc(doc(db, 'sessions', state.session.id, 'players', name));
        showToast(`Jugador "${name}" eliminado`, 'info');
      } catch (e) {
        console.error(e);
        await showAlert('Error al eliminar el jugador.', 'error');
      }
    }
  }
};

window.router = {
  go: (p) => setPage(p)
};

// --- INITIALIZE ---
// Check for URL params to auto-join
function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const joinCode = urlParams.get('session');
  if (joinCode) {
    state.role = 'alumno';
    setPage('join');
    // We wait for the DOM to be ready to set the value
    setTimeout(() => {
      const input = document.getElementById('join-code');
      if (input) input.value = joinCode;
    }, 100);
  } else {
    setPage('landing');
  }
}

checkUrlParams();

// Add Auth Listener
onAuthStateChanged(auth, (user) => {
  if (user) {
    state.user = user;
    state.role = 'profe'; // If user was already logged in, assume profe context
    window.actions.loadQuizzes();
    if (state.currentPage === 'landing') setPage('home');
  } else {
    state.user = null;
    if (state.role === 'profe') {
       state.role = 'none';
       setPage('landing');
    }
  }
});
