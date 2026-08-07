(function () {
  const app = document.getElementById('app');
  const socket = io();

  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const roomMatch = path.match(/^\/room\/([a-zA-Z0-9]+)$/);

  let currentRoomId = roomMatch ? roomMatch[1] : null;
  const isHostFlow = params.get('host') === '1';

  // ---------- Helpers ----------

  function el(html) {
    const div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstChild;
  }

  function shareLink(roomId) {
    return `${window.location.origin}/room/${roomId}`;
  }

  // ---------- Landing page ----------

  function renderLanding() {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="card-panel">
        <h1>🃏 Scrum Poker</h1>
        <p class="subtitle">Создайте комнату и отправьте ссылку команде, чтобы вместе оценить задачи.</p>
        <button class="btn-primary" id="createRoomBtn">Создать комнату</button>
      </div>
    `));

    document.getElementById('createRoomBtn').addEventListener('click', () => {
      socket.emit('room:create', ({ roomId }) => {
        window.location.href = `/room/${roomId}?host=1`;
      });
    });
  }

  // ---------- Name entry (participant) ----------

  function renderNameEntry(roomId) {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="card-panel">
        <h1>Вход в комнату</h1>
        <p class="subtitle">Комната: <strong>${roomId}</strong>. Введите ваше имя, чтобы присоединиться.</p>
        <input type="text" id="nameInput" placeholder="Ваше имя" maxlength="40" />
        <div class="error-msg" id="errorMsg" style="display:none;"></div>
        <button class="btn-primary" id="joinBtn">Войти</button>
      </div>
    `));

    const nameInput = document.getElementById('nameInput');
    const errorMsg = document.getElementById('errorMsg');
    nameInput.focus();

    function tryJoin() {
      const name = nameInput.value.trim();
      if (!name) {
        errorMsg.textContent = 'Пожалуйста, введите имя';
        errorMsg.style.display = 'block';
        return;
      }
      socket.emit('room:join', { roomId, name }, (res) => {
        if (res && res.error) {
          errorMsg.textContent = res.error;
          errorMsg.style.display = 'block';
          return;
        }
        renderParticipantRoom(roomId);
      });
    }

    document.getElementById('joinBtn').addEventListener('click', tryJoin);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryJoin();
    });
  }

  // ---------- Host room view ----------

  function renderHostRoom(roomId) {
    app.innerHTML = '';
    const container = el(`
      <div class="room-container">
        <div class="room-header">
          <div>
            <h1 style="margin-bottom:6px;">Комната хозяина</h1>
            <span class="room-id-badge">ID: ${roomId}</span>
          </div>
        </div>

        <div class="section">
          <h2>Ссылка для команды</h2>
          <div class="link-box">
            <input type="text" id="shareLinkInput" readonly value="${shareLink(roomId)}" />
            <button class="btn-secondary" id="copyLinkBtn">Копировать</button>
          </div>
        </div>

        <div class="section">
          <h2>Участники</h2>
          <div class="progress-text" id="progressText"></div>
          <ul class="participants-list" id="participantsList"></ul>
          <div class="actions-row">
            <button class="btn-primary" id="revealBtn">Вскрыть карты</button>
            <button class="btn-danger" id="clearBtn">Начать заново</button>
          </div>
        </div>
      </div>
    `);
    app.appendChild(container);

    document.getElementById('copyLinkBtn').addEventListener('click', () => {
      const input = document.getElementById('shareLinkInput');
      input.select();
      navigator.clipboard.writeText(input.value).catch(() => {});
    });

    document.getElementById('revealBtn').addEventListener('click', () => {
      socket.emit('room:reveal');
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      socket.emit('room:clear');
    });

    socket.on('room:update', (state) => renderHostState(state));
  }

  function renderHostState(state) {
    const list = document.getElementById('participantsList');
    const progressText = document.getElementById('progressText');
    if (!list) return;

    progressText.textContent = `Проголосовало ${state.voteCount} из ${state.totalCount}`;

    if (state.participants.length === 0) {
      list.innerHTML = '<li class="hint">Пока никто не присоединился</li>';
      return;
    }

    list.innerHTML = '';
    state.participants.forEach((p) => {
      const row = document.createElement('li');
      row.className = 'participant-row';

      let voteDisplay = '';
      if (state.revealed) {
        voteDisplay = `<span class="vote-badge">${p.vote === 'coffee' ? '☕' : p.vote}</span>`;
      }

      row.innerHTML = `
        <span class="participant-name">
          <span class="status-dot ${p.hasVoted ? 'voted' : ''}"></span>
          ${escapeHtml(p.name)}
        </span>
        ${voteDisplay}
      `;
      list.appendChild(row);
    });
  }

  // ---------- Participant room view ----------

  function renderParticipantRoom(roomId) {
    app.innerHTML = '';
    const container = el(`
      <div class="room-container">
        <div class="room-header">
          <div>
            <h1 style="margin-bottom:6px;">Оценка задачи</h1>
            <span class="room-id-badge">Комната: ${roomId}</span>
          </div>
        </div>

        <div class="section">
          <h2>Ваша оценка</h2>
          <div class="vote-form">
            <div class="field">
              <label for="numInput">Число от 1 до 50</label>
              <input type="number" id="numInput" min="1" max="50" placeholder="напр. 5" />
            </div>
            <button class="btn-primary num-submit" id="submitNumBtn" style="width:auto;">Проголосовать</button>
            <button class="coffee-btn" id="coffeeBtn">☕ Не могу оценить</button>
          </div>
          <div class="my-vote-display" id="myVoteDisplay"></div>
        </div>

        <div class="section">
          <h2>Участники</h2>
          <div class="progress-text" id="progressText"></div>
          <ul class="participants-list" id="participantsList"></ul>
        </div>
      </div>
    `);
    app.appendChild(container);

    let myVote = null;

    function updateMyVoteDisplay() {
      const display = document.getElementById('myVoteDisplay');
      if (!display) return;
      if (myVote === null) {
        display.textContent = 'Вы еще не проголосовали';
      } else {
        display.innerHTML = `Ваш голос: <strong>${myVote === 'coffee' ? '☕ Кофе' : myVote}</strong>`;
      }
    }

    document.getElementById('submitNumBtn').addEventListener('click', () => {
      const val = document.getElementById('numInput').value;
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 1 || num > 50) return;
      myVote = num;
      socket.emit('vote:cast', { value: num });
      updateMyVoteDisplay();
    });

    document.getElementById('coffeeBtn').addEventListener('click', () => {
      myVote = 'coffee';
      socket.emit('vote:cast', { value: 'coffee' });
      updateMyVoteDisplay();
    });

    document.getElementById('numInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('submitNumBtn').click();
    });

    socket.on('room:update', (state) => {
      renderParticipantState(state);
      if (!state.revealed && state.participants.every((p) => !p.hasVoted)) {
        // round was cleared server-side
        myVote = null;
        document.getElementById('numInput').value = '';
        updateMyVoteDisplay();
      }
    });

    updateMyVoteDisplay();
  }

  function renderParticipantState(state) {
    const list = document.getElementById('participantsList');
    const progressText = document.getElementById('progressText');
    if (!list) return;

    progressText.textContent = `Проголосовало ${state.voteCount} из ${state.totalCount}`;

    if (state.participants.length === 0) {
      list.innerHTML = '<li class="hint">Пока никто не присоединился</li>';
      return;
    }

    list.innerHTML = '';
    state.participants.forEach((p) => {
      const row = document.createElement('li');
      row.className = 'participant-row';

      let voteDisplay = '';
      if (state.revealed) {
        voteDisplay = `<span class="vote-badge">${p.vote === 'coffee' ? '☕' : p.vote}</span>`;
      }

      row.innerHTML = `
        <span class="participant-name">
          <span class="status-dot ${p.hasVoted ? 'voted' : ''}"></span>
          ${escapeHtml(p.name)}
        </span>
        ${voteDisplay}
      `;
      list.appendChild(row);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Router ----------

  if (!currentRoomId) {
    renderLanding();
  } else if (isHostFlow) {
    socket.emit('room:host-join', { roomId: currentRoomId }, (res) => {
      if (res && res.error) {
        app.innerHTML = `<div class="card-panel"><h1>Комната не найдена</h1><p class="subtitle">${res.error}</p></div>`;
        return;
      }
      renderHostRoom(currentRoomId);
      renderHostState(res.state);
    });
  } else {
    renderNameEntry(currentRoomId);
  }
})();
