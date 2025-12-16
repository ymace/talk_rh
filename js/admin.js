(function() {
  // State
  let allLeaves = [];
  let currentFilterUser = 'ALL';
  let currentFilterStatus = 'ALL';
  const today = new Date();
  let currentYear = today.getFullYear();
  let currentMonth = today.getMonth(); // 0-11
  let currentView = 'calendar'; // 'calendar' | 'list'

  const monthNamesFr = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Utils
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoFromDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function formatDateFr(iso) {
    if (!iso) return '';
    const parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  function formatDateLongFr(iso) {
    if (!iso) return '';
    try {
      const [y, m, d] = iso.split('-').map(x => parseInt(x, 10));
      const dt = new Date(y, (m - 1), d);
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(dt);
    } catch (e) { return formatDateFr(iso); }
  }

  // Keep capitalization purely presentational for long French dates
  function titleCaseFr(s) {
    if (!s) return s;
    return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // Day-parts helpers
  function parseDayParts(dp) {
    // Accept map { 'YYYY-MM-DD': 'full|am|pm' } or array [{date, part}] or string
    if (!dp) return null;
    try {
      if (typeof dp === 'string') {
        const s = dp.trim();
        if (s && (s[0] === '{' || s[0] === '[')) {
          dp = JSON.parse(s);
        } else {
          // Single date string means that date (rare), ignore for map
          return null;
        }
      }
      if (dp && !Array.isArray(dp) && typeof dp === 'object') {
        // object map
        return dp;
      }
      if (Array.isArray(dp)) {
        const map = {};
        dp.forEach(item => {
          if (item && typeof item === 'object' && item.date) {
            map[item.date] = item.part || 'full';
          }
        });
        return map;
      }
    } catch (_) {}
    return null;
  }

  function eachDate(startIso, endIso) {
    const results = [];
    try {
      const start = new Date(startIso);
      const end = new Date(endIso);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const y = d.getFullYear();
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        results.push(`${y}-${m}-${day}`);
      }
    } catch (_){ }
    return results;
  }

  function getDayPartFor(leave, isoDate) {
    const map = parseDayParts(leave.day_parts);
    if (map && Object.prototype.hasOwnProperty.call(map, isoDate)) {
      const p = map[isoDate];
      if (p === 'am' || p === 'pm' || p === 'full') return p;
    }
    return 'full';
  }

  function labelForPart(p) {
    return p === 'am' ? 'Matin' : (p === 'pm' ? 'Après-midi' : 'Journée complète');
  }

  function leavesFiltered() {
    let filtered = currentFilterUser === 'ALL' ? allLeaves : allLeaves.filter(l => l.uid === currentFilterUser);
    if (currentFilterStatus !== 'ALL') {
      filtered = filtered.filter(l => l.status === currentFilterStatus);
    }
    return filtered;
  }

  function renderList() {
    const listView = document.getElementById('adminListView');
    const tbody = document.querySelector('#adminListTable tbody');
    if (!listView || !tbody) return;
    tbody.innerHTML = '';
    const rows = leavesFiltered().slice().sort((a,b) => {
      // sort by start_date desc then id desc
      if (a.start_date === b.start_date) return (b.id || 0) - (a.id || 0);
      return a.start_date > b.start_date ? -1 : 1;
    });
    rows.forEach(l => {
      const tr = document.createElement('tr');
      // Add status-based class to the main row
      if (l.status === 'pending' || l.status === 'approved' || l.status === 'rejected') {
        tr.classList.add('row-' + l.status);
      }
      const tdId = document.createElement('td');
      tdId.textContent = '#' + l.id;
      const tdUser = document.createElement('td');
      tdUser.textContent = l.uid;
      const tdStart = document.createElement('td');
      tdStart.textContent = formatDateLongFr(l.start_date);
      const tdEnd = document.createElement('td');
      tdEnd.textContent = formatDateLongFr(l.end_date);
      const tdType = document.createElement('td');
      tdType.textContent = l.type === 'paid' ? 'Soldé' : (l.type === 'unpaid' ? 'Sans Solde' : 'Récup.');
      const tdStatus = document.createElement('td');
      // Wrap status in a span with badge classes
      const statusSpan = document.createElement('span');
      statusSpan.className = 'talkrh-badge badge-' + l.status;
      statusSpan.textContent = l.status === 'pending' ? 'En attente' : (l.status === 'approved' ? 'Approuvée' : 'Refusée');
      tdStatus.appendChild(statusSpan);
      const tdActions = document.createElement('td');
      if (l.status === 'pending') {
        const approve = document.createElement('button');
        approve.className = 'button icon-button approve';
        approve.title = 'Approuver';
        approve.textContent = '✓';
        approve.onclick = async () => {
          const form = new FormData();
          form.append('status', 'approved');
          try { if (window.talkrhLoader) window.talkrhLoader.show(); } catch(_) {}
          try {
            await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id + '/status'), { method: 'POST', body: form });
          } finally {
            try { if (window.talkrhLoader) window.talkrhLoader.hide(); } catch(_) {}
          }
          await loadAll();
        };
        const reject = document.createElement('button');
        reject.className = 'button icon-button danger reject';
        reject.title = 'Refuser';
        reject.textContent = '✕';
        reject.onclick = async () => {
          const form = new FormData();
          form.append('status', 'rejected');
          await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id + '/status'), { method: 'POST', body: form });
          await loadAll();
        };
        tdActions.appendChild(approve);
        tdActions.appendChild(reject);
      } else {
        const reject = document.createElement('button');
        reject.className = 'button icon-button danger reject';
        reject.title = 'Supprimer';
        reject.textContent = '✕';
        reject.onclick = async () => {
          OC.dialogs.confirm(
              'Voulez-vous vraiment supprimer ce congé ?', 
              'Confirmation de suppression',              
              async function(result) {                    
                  if (result) {
                      const form = new FormData();
                      form.append('status', 'rejected');
                      await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id), { method: 'DELETE', body: form });
                      await loadAll();
                  }
              }
          );
        };
        tdActions.appendChild(reject);
      }
      tr.appendChild(tdId);
      tr.appendChild(tdUser);
      tr.appendChild(tdStart);
      tr.appendChild(tdEnd);
      tr.appendChild(tdType);
      tr.appendChild(tdStatus);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);

      // Details row (collapsed by default)
      const detailsTr = document.createElement('tr');
      const detailsTd = document.createElement('td');
      detailsTd.colSpan = 7;
      const details = document.createElement('div');
      details.className = 'talkrh-card list-detail';
      const ul = document.createElement('ul');
      ul.className = 'talkrh-list';
      eachDate(l.start_date, l.end_date).forEach(iso => {
        const li = document.createElement('li');
        const part = getDayPartFor(l, iso);
        const label = labelForPart(part);
        const dateTxt = titleCaseFr(formatDateLongFr(iso));
        li.textContent = dateTxt + (part !== 'full' ? ' - ' + label : '');
        ul.appendChild(li);
      });
      details.appendChild(ul);
      details.style.display = 'none';
      detailsTd.appendChild(details);
      detailsTr.appendChild(detailsTd);
      tbody.appendChild(detailsTr);

      // Toggle on row click (ignore clicks on buttons)
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        details.style.display = details.style.display === 'none' ? '' : 'none';
      });
    });
  }

  function render() {
    if (currentView === 'calendar') {
      const cal = document.getElementsByClassName('talkrh-calendar')[0];
      const list = document.getElementById('adminListView');
      if (cal) cal.style.display = '';
      if (list) list.style.display = 'none';
      renderCalendar();
    } else {
      const cal = document.getElementsByClassName('talkrh-calendar')[0];
      const list = document.getElementById('adminListView');
      if (cal) cal.style.display = 'none';
      if (list) list.style.display = '';
      renderList();
    }
  }

  function populateFilter(leaves) {
    const sel = document.getElementById('filterUser');
    const selStatus = document.getElementById('filterStatus');
    if (!sel) return;
    const seen = new Set();
    const prev = sel.value || 'ALL';
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'ALL';
    optAll.textContent = 'Tous les employés';
    sel.appendChild(optAll);
    leaves.forEach(l => {
      if (!seen.has(l.uid)) {
        seen.add(l.uid);
        const o = document.createElement('option');
        o.value = l.uid;
        o.textContent = l.uid;
        sel.appendChild(o);
      }
    });
    if ([...seen, 'ALL'].includes(prev)) {
      sel.value = prev;
      currentFilterUser = prev;
    } else {
      sel.value = 'ALL';
      currentFilterUser = 'ALL';
    }
    sel.onchange = () => {
      currentFilterUser = sel.value;
      render();
    };
    if (selStatus) {
      selStatus.onchange = () => {
        currentFilterStatus = selStatus.value;
        render();
      };
    }
  }

  function leavesForDate(iso) {
    let filtered = currentFilterUser === 'ALL' ? allLeaves : allLeaves.filter(l => l.uid === currentFilterUser);
    if (currentFilterStatus !== 'ALL') {
      filtered = filtered.filter(l => l.status === currentFilterStatus);
    }
    return filtered.filter(l => iso >= l.start_date && iso <= l.end_date);
  }

  function closeModal() {
    const backdrop = document.getElementById('talkrhModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function openModalForDate(iso) {
    const backdrop = document.getElementById('talkrhModalBackdrop');
    const titleEl = document.getElementById('talkrhModalTitle');
    const bodyEl = document.getElementById('talkrhModalBody');
    if (!backdrop || !titleEl || !bodyEl) return;
    const items = leavesForDate(iso);
    if (!items.length) {
      closeModal();
      return;
    }
    titleEl.textContent = 'Détails du ' + titleCaseFr(formatDateLongFr(iso));
    bodyEl.innerHTML = '';
    items.forEach(l => {
      const card = document.createElement('div');
      card.className = 'talkrh-card';
      const head = document.createElement('div');
      head.className = 'title';
      head.textContent = `#${l.id} • ${l.uid}`;
      const meta = document.createElement('div');
      meta.className = 'talkrh-meta';
      meta.textContent = `${formatDateLongFr(l.start_date)} → ${formatDateLongFr(l.end_date)}` + (l.reason ? ` • Raison: ${l.reason}` : '');
      const badges = document.createElement('div');
      badges.className = 'talkrh-badges';
      const type = document.createElement('span');
      type.className = 'talkrh-badge';
      type.textContent = l.type === 'paid' ? 'Soldé' : (l.type === 'unpaid' ? 'Sans Solde' : 'Récup.');
      const status = document.createElement('span');
      status.className = 'talkrh-badge badge-' + l.status;
      status.textContent = l.status === 'pending' ? 'En attente' : (l.status === 'approved' ? 'Approuvée' : 'Refusée');
      badges.appendChild(type);
      badges.appendChild(status);
      if (l.admin_comment) {
        const comment = document.createElement('span');
        comment.className = 'talkrh-badge';
        comment.textContent = 'Commentaire: ' + l.admin_comment;
        badges.appendChild(comment);
      }
      // Collapsible details of days
      const toggle = document.createElement('button');
      toggle.className = 'button';
      toggle.textContent = 'Voir les jours';
      const details = document.createElement('div');
      details.style.display = 'none';
      const ul = document.createElement('ul');
      ul.className = 'talkrh-list';
      eachDate(l.start_date, l.end_date).forEach(iso => {
        const li = document.createElement('li');
        const part = getDayPartFor(l, iso);
        const dateTxt = titleCaseFr(formatDateLongFr(iso));
        li.textContent = dateTxt + (part !== 'full' ? ' - ' + labelForPart(part) : '');
        ul.appendChild(li);
      });
      details.appendChild(ul);
      toggle.addEventListener('click', () => {
        details.style.display = details.style.display === 'none' ? '' : 'none';
      });
      const actions = document.createElement('div');
      actions.className = 'talkrh-actions';
      if (l.status === 'pending') {
        const approve = document.createElement('button');
        approve.textContent = 'Approuver';
        approve.onclick = async () => {
          const comment = prompt('Commentaire (optionnel)') || '';
          const form = new FormData();
          form.append('status', 'approved');
          if (comment) form.append('adminComment', comment);
          try { if (window.talkrhLoader) window.talkrhLoader.show(); } catch(_) {}
          try {
            await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id + '/status'), { method: 'POST', body: form });
          } finally {
            try { if (window.talkrhLoader) window.talkrhLoader.hide(); } catch(_) {}
          }
          await loadAll();
          closeModal();
        };
        const reject = document.createElement('button');
        reject.className = 'danger';
        reject.textContent = 'Refuser';
        reject.onclick = async () => {
          const comment = prompt('Commentaire (optionnel)') || '';
          const form = new FormData();
          form.append('status', 'rejected');
          if (comment) form.append('adminComment', comment);
          try { if (window.talkrhLoader) window.talkrhLoader.show(); } catch(_) {}
          try {
            await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id + '/status'), { method: 'POST', body: form });
          } finally {
            try { if (window.talkrhLoader) window.talkrhLoader.hide(); } catch(_) {}
          }
          await loadAll();
          closeModal();
        };
        actions.appendChild(approve);
        actions.appendChild(reject);
      }else{
        const reject = document.createElement('button');
        reject.className = 'danger';
        reject.textContent = 'Supprimer';
        reject.onclick = async () => {
          OC.dialogs.confirm(
              'Voulez-vous vraiment supprimer ce congé ?', 
              'Confirmation de suppression',              
              async function(result) {                    
                  if (result) {
                      try {
                        await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves/' + l.id), { method: 'DELETE'});
                      } finally {
                        try { if (window.talkrhLoader) window.talkrhLoader.hide(); } catch(_) {}
                      }
                      await loadAll();
                      closeModal();
                  }
              }
          );
        };
        actions.appendChild(reject);
      }



      card.appendChild(head);
      card.appendChild(meta);
      card.appendChild(badges);
      card.appendChild(toggle);
      card.appendChild(details);
      card.appendChild(actions);
      bodyEl.appendChild(card);
    });
    backdrop.style.display = 'block';
  }

  async function openSettingsModal() {
    const backdrop = document.getElementById('talkrhModalBackdrop');
    const titleEl = document.getElementById('talkrhModalTitle');
    const bodyEl = document.getElementById('talkrhModalBody');
    if (!backdrop || !titleEl || !bodyEl) return;

    titleEl.textContent = 'Paramètres · Groupe administrateur';
    bodyEl.innerHTML = '';

    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = 'Groupe admin';
    label.htmlFor = 'settingsGroupSelect';
    const select = document.createElement('select');
    select.id = 'settingsGroupSelect';
    select.className = '';
    field.appendChild(label);
    field.appendChild(select);

    const membersTitle = document.createElement('h4');
    membersTitle.textContent = 'Membres du groupe';
    const membersList = document.createElement('ul');
    membersList.id = 'settingsMembersList';
    membersList.className = 'talkrh-list';

    const actions = document.createElement('div');
    actions.className = 'talkrh-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'button primary';
    saveBtn.textContent = 'Enregistrer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'button';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => closeModal();
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    bodyEl.appendChild(field);
    bodyEl.appendChild(membersTitle);
    bodyEl.appendChild(membersList);
    bodyEl.appendChild(actions);

    async function loadMembers(groupId) {
      membersList.innerHTML = '';
      try {
        const res = await fetch(OC.generateUrl('/apps/talk_rh/api/admin/settings/group/members') + '?groupId=' + encodeURIComponent(groupId));
        const data = await res.json();
        const mem = Array.isArray(data.members) ? data.members : [];
        if (mem.length === 0) {
          const li = document.createElement('li');
          li.textContent = 'Aucun membre dans ce groupe.';
          membersList.appendChild(li);
        } else {
          mem.forEach(u => {
            const li = document.createElement('li');
            li.textContent = `${u.displayName || u.uid} (${u.uid})`;
            membersList.appendChild(li);
          });
        }
      } catch (e) {
        const li = document.createElement('li');
        li.textContent = 'Erreur de chargement des membres.';
        membersList.appendChild(li);
      }
    }

    try {
      // Load current group id
      const currentRes = await fetch(OC.generateUrl('/apps/talk_rh/api/admin/settings/group'));
      const currentData = await currentRes.json();
      const currentGid = currentData.groupId || '';
      // Load groups
      const groupsRes = await fetch(OC.generateUrl('/apps/talk_rh/api/admin/settings/groups'));
      const groupsData = await groupsRes.json();
      const groups = Array.isArray(groupsData.groups) ? groupsData.groups : [];
      select.innerHTML = '';
      groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.displayName || g.id;
        select.appendChild(opt);
      });
      if (currentGid && groups.some(g => g.id === currentGid)) {
        select.value = currentGid;
      }
      select.onchange = () => loadMembers(select.value);
      await loadMembers(select.value);

      saveBtn.onclick = async () => {
        const form = new FormData();
        form.append('groupId', select.value);
        await fetch(OC.generateUrl('/apps/talk_rh/api/admin/settings/group'), { method: 'POST', body: form });
        closeModal();
      };
    } catch (e) {
      const li = document.createElement('div');
      li.textContent = 'Erreur de chargement de la configuration.';
      bodyEl.appendChild(li);
    }

    backdrop.style.display = 'block';
  }

  function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const label = document.getElementById('monthLabel');
    if (!grid || !label) return; 
    grid.innerHTML = '';
    label.textContent = monthNamesFr[currentMonth] + ' ' + currentYear;

    // Compute first day (Mon-based) and total cells (6 weeks)
    const firstOfMonth = new Date(currentYear, currentMonth, 1);
    const startWeekdayMonBased = (firstOfMonth.getDay() + 6) % 7; // 0 = Monday
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const prevMonthDays = startWeekdayMonBased; // number of days from previous month to show
    const totalCells = 42; // 6 weeks x 7
    const startDate = new Date(currentYear, currentMonth, 1 - prevMonthDays);

    for (let i = 0; i < totalCells; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const iso = isoFromDate(d);
      const inCurrent = d.getMonth() === currentMonth;
      const isToday = iso === isoFromDate(today);

      const cell = document.createElement('div');
      cell.className = 'day-cell' + (inCurrent ? '' : ' outside') + (isToday ? ' day-today' : '');
      const header = document.createElement('div');
      header.className = 'day-header';
      const num = document.createElement('div');
      num.className = 'day-number';
      num.textContent = d.getDate();
      header.appendChild(num);
      cell.appendChild(header);

      const events = document.createElement('div');
      events.className = 'events';
      const items = leavesForDate(iso);
      items.forEach(l => {
        const ev = document.createElement('div');
        ev.className = 'event-badge talkrh-badge badge-' + l.status;
        const typeLabel = l.type === 'paid' ? 'Soldé' : (l.type === 'unpaid' ? 'Sans Solde' : 'Récup.');
        const statusLabel = l.status === 'pending' ? 'En attente' : (l.status === 'approved' ? 'Approuvée' : 'Refusée');
        const who = currentFilterUser === 'ALL' ? (l.uid + ' • ') : '';
        const part = getDayPartFor(l, iso);
        const half = part !== 'full' ? ' · ½ ' + (part === 'am' ? 'matin' : 'après-midi') : '';
        ev.textContent = who + typeLabel + ' · ' + statusLabel + half;
        events.appendChild(ev);
      });
      cell.appendChild(events);

      cell.addEventListener('click', () => openModalForDate(iso));
      grid.appendChild(cell);
    }
  }

  async function loadAll() {
    try {
      try { if (window.talkrhLoader) window.talkrhLoader.show(); } catch(_) {}
      const res = await fetch(OC.generateUrl('/apps/talk_rh/api/admin/leaves'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      allLeaves = Array.isArray(data.leaves) ? data.leaves : [];
      populateFilter(allLeaves);
      render();
    } catch (e) {
      console.error('[talk_rh] admin.js: error fetching leaves', e);
    } finally {
      try { if (window.talkrhLoader) window.talkrhLoader.hide(); } catch(_) {}
    }
  }

  function bindMonthNav() {
    const prev = document.getElementById('prevMonth');
    const next = document.getElementById('nextMonth');
    if (prev) prev.onclick = () => { currentMonth -= 1; if (currentMonth < 0) { currentMonth = 11; currentYear -= 1; } renderCalendar(); };
    if (next) next.onclick = () => { currentMonth += 1; if (currentMonth > 11) { currentMonth = 0; currentYear += 1; } renderCalendar(); };
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindMonthNav();
    // Modal close bindings
    const closeBtn = document.getElementById('talkrhModalClose');
    const backdrop = document.getElementById('talkrhModalBackdrop');
    if (closeBtn) closeBtn.onclick = closeModal;
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    const openSettingsBtn = document.getElementById('openSettings');
    if (openSettingsBtn) openSettingsBtn.onclick = openSettingsModal;
    const navViewCal = document.getElementById('navViewCalendar');
    const navViewList = document.getElementById('navViewList');

    // Initialize current view from URL param if provided
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      if (v === 'list' || v === 'calendar') {
        currentView = v;
      }
    } catch (e) { /* ignore */ }
    function updateTitle() {
      try {
        document.title = (currentView === 'list') ? 'Gestion des congés · Vue liste · Talk RH' : 'Gestion des congés · Vue calendrier · Talk RH';
      } catch(_) {}
    }

    if (navViewCal) {
      navViewCal.addEventListener('click', (e) => { 
        e.preventDefault(); 
        currentView = 'calendar'; 
        // Persist view in URL
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('view', 'calendar');
          window.history.replaceState(null, '', url);
        } catch (e) { /* ignore */ }
        updateActiveNav();
        updateTitle();
        render(); 
      });
    }
    if (navViewList) {
      navViewList.addEventListener('click', (e) => { 
        e.preventDefault(); 
        currentView = 'list'; 
        // Persist view in URL
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('view', 'list');
          window.history.replaceState(null, '', url);
        } catch (e) { /* ignore */ }
        updateActiveNav();
        updateTitle();
        render(); 
      });
    }
    
    function updateActiveNav() {
      // Ensure main admin entry stays active with more robust selector
      const adminEntry = document.querySelector('.app-navigation-entry-link[href="/apps/talk_rh/page"]');
      if (adminEntry && !adminEntry.closest('.app-navigation-entry__children')) {
        const navEntry = adminEntry.closest('.app-navigation-entry');
        if (navEntry) {
          navEntry.classList.add('active');
        }
      }
      
      // Remove active class from sub-menu items only
      document.querySelectorAll('#nav-calendar, #nav-list').forEach(el => el.classList.remove('active'));
      
      // Add active class to current view
      if (currentView === 'calendar') {
        const calEl = document.getElementById('nav-calendar');
        if (calEl) calEl.classList.add('active');
      } else if (currentView === 'list') {
        const listEl = document.getElementById('nav-list');
        if (listEl) listEl.classList.add('active');
      }

    }
    
    // Set initial active state (after possibly reading URL param)
    updateActiveNav();
    // Initial title
    updateTitle();
    loadAll();
  });
})();
