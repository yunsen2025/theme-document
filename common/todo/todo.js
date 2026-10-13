/**
 * 待办事项前端逻辑
 * LocalStorage 缓存 + AJAX 同步 + 2D 艾森豪威尔矩阵视图
 * @author Haibin
 * @date 2026-04-17
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'document_todos';
    const COLLAPSED_KEY = 'document_todo_collapsed';
    const VIEW_KEY = 'document_todo_view';
    const FILTER_KEY = 'document_todo_filter';
    const SEARCH_KEY = 'document_todo_search';
    const AJAX_URL = window.HOME + '/wp-admin/admin-ajax.php';

    let todos = [];
    let currentFilter = loadPreference(FILTER_KEY, 'all');
    let currentView = loadPreference(VIEW_KEY, 'list');
    let searchQuery = loadPreference(SEARCH_KEY, '');
    let editingId = null;
    let dragItem = null;
    let dragSnapshot = null;
    let dragReparented = false;
    let dragDropTarget = null;
    let pendingParentId = '';
    let pendingDependencies = [];
    let collapsedIds = loadCollapsedIds();
    let mutationBusy = {};
    let createBusy = false;

    function loadPreference(key, fallback) {
        try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
    }
    function savePreference(key, value) { try { localStorage.setItem(key, value); } catch (e) { } }

    function showMessage(message, type) {
        var stats = document.getElementById('todo-stats');
        if (!stats) return;
        var old = stats.querySelector('.todo-client-message');
        if (old) old.remove();
        var notice = document.createElement('span');
        notice.className = 'todo-client-message ' + (type || 'error');
        notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
        notice.textContent = message;
        stats.appendChild(notice);
        if (type !== 'error') window.setTimeout(function () { if (notice.parentNode) notice.remove(); }, 3500);
    }

    function snapshotTodos() { return todos.map(function (todo) { return Object.assign({}, todo, { dependencies: dependencyIdsOf(todo).slice() }); }); }
    function restoreSnapshot(snapshot) { todos = snapshot; saveToLocal(); render(); }
    function beginMutation(id) {
        var key = String(id);
        if (mutationBusy[key]) return false;
        mutationBusy[key] = true;
        return true;
    }
    function endMutation(id) { delete mutationBusy[String(id)]; }

    // Chart state
    let chartCanvas = null;
    let chartCtx = null;
    let chartPoints = [];
    let hoveredPoint = null;
    let chartPadding = { top: 40, right: 40, bottom: 50, left: 60 };

    /* ========== LocalStorage ========== */
    function saveToLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(todos)); } catch (e) { } }
    function loadFromLocal() { try { var d = localStorage.getItem(STORAGE_KEY); return d ? JSON.parse(d) : []; } catch (e) { return []; } }
    function loadCollapsedIds() { try { var d = localStorage.getItem(COLLAPSED_KEY); return d ? JSON.parse(d) : {}; } catch (e) { return {}; } }
    function saveCollapsedIds() { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedIds)); } catch (e) { } }

    /* ========== AJAX ========== */
    function ajax(action, data) {
        return new Promise(function (resolve, reject) {
            var fd = new FormData();
            fd.append('action', action);
            fd.append('nonce', window.DOCUMENT_NONCE || '');
            if (data) Object.keys(data).forEach(function (k) { fd.append(k, data[k]); });
            fetch(AJAX_URL, { method: 'POST', body: fd, credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (res) { res.success ? resolve(res.data) : reject(res.data); })
                .catch(reject);
        });
    }
    function syncFromServer(silent) {
        return ajax('todo_list').then(function (data) {
            todos = Array.isArray(data) ? data : [];
            saveToLocal(); render();
            return todos;
        }).catch(function (error) {
            if (!silent) showMessage(typeof error === 'string' ? error : '同步失败，暂时保留本地显示。', 'error');
            throw error;
        });
    }

    /* ========== 日期计算 ========== */
    function getDaysRemaining(dateStr) {
        if (!dateStr) return null;
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var due = new Date(dateStr); due.setHours(0, 0, 0, 0);
        return Math.ceil((due - today) / 86400000);
    }
    function formatDate(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    function getCountdownHtml(todo) {
        if (!todo.due_date || todo.completed == 1) return '';
        var days = getDaysRemaining(todo.due_date);
        if (days === null) return '';
        var cls, text;
        if (days < 0) { cls = 'overdue'; text = '已过期' + Math.abs(days) + '天'; }
        else if (days === 0) { cls = 'urgent'; text = '今天截止'; }
        else if (days === 1) { cls = 'urgent'; text = '明天截止'; }
        else if (days <= 3) { cls = 'urgent'; text = '剩余' + days + '天'; }
        else if (days <= 14) { cls = 'soon'; text = '剩余' + days + '天'; }
        else { cls = 'normal'; text = '剩余' + days + '天'; }
        return '<span class="todo-countdown ' + cls + '">' + text + '</span>';
    }
    function isOverdue(todo) {
        if (!todo.due_date || todo.completed == 1) return false;
        var d = getDaysRemaining(todo.due_date); return d !== null && d < 0;
    }

    /* ========== 紧急度：4级 + 自动升级 ========== */
    // priority: anytime(随时可以) / thisweek(这周处理) / twodays(这两天) / urgent(紧急)
    var PRIORITY_MAP = {
        urgent:   { label: '紧急',     css: 'urgent',   level: 4 },
        twodays:  { label: '这两天',   css: 'twodays',  level: 3 },
        thisweek: { label: '这周处理', css: 'thisweek', level: 2 },
        anytime:  { label: '随时可以', css: 'anytime',  level: 1 },
        // 向后兼容旧数据
        high:     { label: '紧急',     css: 'urgent',   level: 4 },
        medium:   { label: '这周处理', css: 'thisweek', level: 2 },
        low:      { label: '随时可以', css: 'anytime',  level: 1 }
    };

    function priorityLabel(p) {
        return (PRIORITY_MAP[p] || PRIORITY_MAP.thisweek).label;
    }
    function priorityCss(p) {
        return (PRIORITY_MAP[p] || PRIORITY_MAP.thisweek).css;
    }

    /**
     * 根据截止日期自动升级紧急度（只升不降）
     * 规则：
     *   <= 0天 → urgent
     *   <= 3天 → 至少 twodays
     *   <= 14天 → 至少 thisweek
     */
    function getEffectivePriority(todo) {
        var base = todo.priority || 'thisweek';
        if (!todo.due_date || todo.completed == 1) return base;
        var days = getDaysRemaining(todo.due_date);
        if (days === null) return base;

        var baseLevel = (PRIORITY_MAP[base] || PRIORITY_MAP.thisweek).level;

        if (days <= 0 && baseLevel < 4) return 'urgent';
        if (days <= 3 && baseLevel < 3) return 'twodays';
        if (days <= 14 && baseLevel < 2) return 'thisweek';
        return base;
    }

    function importanceStars(v) {
        v = parseInt(v) || 3;
        var s = '';
        for (var i = 0; i < 5; i++) s += i < v ? '★' : '☆';
        return s;
    }

    /**
     * 计算有效重要度（图表用）
     * >14天的待办：每隔7天升高0.5★，14天=3★
     * 即 effectiveImportance = max(原importance, 3 + (days - 14) / 7 * 0.5)
     * 上限5
     */
    function getEffectiveImportance(todo) {
        var imp = parseInt(todo.importance) || 3;
        if (!todo.due_date || todo.completed == 1) return imp;
        var days = getDaysRemaining(todo.due_date);
        if (days === null || days <= 14) return imp;
        var boost = 3 + (days - 14) / 7 * 0.5;
        return Math.min(5, Math.max(imp, boost));
    }

    /* ========== 任务树 ========== */
    function sameId(a, b) { return String(a) === String(b); }
    function parentIdOf(todo) { return todo && todo.parent_id ? String(todo.parent_id) : ''; }
    function dependencyIdsOf(todo) {
        return Array.isArray(todo && todo.dependencies) ? todo.dependencies.map(String) : [];
    }
    function dependenciesOf(todo) {
        return dependencyIdsOf(todo).map(function (id) {
            return todos.find(function (item) { return sameId(item.id, id); });
        }).filter(Boolean);
    }
    function isBlocked(todo) {
        return todo.completed != 1 && dependenciesOf(todo).some(function (dependency) {
            return dependency.completed != 1;
        });
    }
    function dependencyNames(todo) {
        return dependenciesOf(todo).filter(function (dependency) { return dependency.completed != 1; }).map(function (dependency) {
            return dependency.title;
        });
    }
    function childrenOf(parentId, source) {
        var key = parentId ? String(parentId) : '';
        return (source || todos).filter(function (todo) {
            return parentIdOf(todo) === key;
        }).sort(function (a, b) {
            var order = (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0);
            return order || String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id);
        });
    }
    function childPriority(todo) {
        if (todo.completed == 1) return -1;
        return isBlocked(todo) ? 1 : 0;
    }
    function childPreview(todo) {
        return childrenOf(todo.id, todos).filter(function (child) { return child.archived != 1; }).sort(function (a, b) {
            return childPriority(a) - childPriority(b) || priorityLevel(getEffectivePriority(b)) - priorityLevel(getEffectivePriority(a)) || (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0);
        });
    }
    function nextAvailableChild(todo) {
        return childPreview(todo).find(function (child) { return child.completed != 1 && !isBlocked(child); }) || null;
    }
    function treeRows(source, respectCollapsed) {
        var rows = [], used = {};
        source = source || todos;
        function visit(parentId, depth) {
            childrenOf(parentId, source).forEach(function (todo) {
                var key = String(todo.id);
                if (used[key]) return;
                used[key] = true;
                rows.push({ todo: todo, depth: depth });
                if (!respectCollapsed || !collapsedIds[key]) visit(key, depth + 1);
            });
        }
        visit('', 0);
        source.forEach(function (todo) {
            if (!used[String(todo.id)]) {
                used[String(todo.id)] = true;
                rows.push({ todo: todo, depth: 0 });
                if (!respectCollapsed || !collapsedIds[String(todo.id)]) visit(String(todo.id), 1);
            }
        });
        return rows;
    }
    function taskOptionRows() {
        var candidates = todos.filter(function (todo) {
            return todo.archived != 1 && String(todo.id).indexOf('temp_') !== 0;
        });
        if (!candidates.length) return [];

        // Keep the hierarchy when legacy rows are consistent; otherwise do not
        // let one malformed parent_id hide every valid task from the form.
        var rows = [];
        try { rows = treeRows(candidates, false); } catch (e) { rows = []; }
        if (rows.length === candidates.length) return rows;
        return candidates.map(function (todo) { return { todo: todo, depth: 0 }; });
    }
    function descendantLeaves(todoId, source) {
        var result = [], seen = {};
        function visit(parentId) {
            childrenOf(parentId, source).forEach(function (child) {
                var key = String(child.id);
                if (seen[key]) return;
                seen[key] = true;
                var children = childrenOf(child.id, source);
                if (children.length) visit(child.id);
                else result.push(child);
            });
        }
        visit(todoId);
        return result;
    }
    function descendantTasks(todoId, source) {
        var result = [], seen = {};
        function visit(parentId) {
            childrenOf(parentId, source).forEach(function (child) {
                var key = String(child.id);
                if (seen[key]) return;
                seen[key] = true;
                result.push(child);
                visit(child.id);
            });
        }
        visit(todoId);
        return result;
    }
    function treeProgress(todo) {
        var leaves = descendantLeaves(todo.id, todos);
        if (!leaves.length) return null;
        var done = leaves.filter(function (leaf) { return leaf.completed == 1; }).length;
        return { done: done, total: leaves.length };
    }
    function priorityLevel(priority) { return (PRIORITY_MAP[priority] || PRIORITY_MAP.thisweek).level; }
    function treePriority(todo) {
        var descendants = descendantTasks(todo.id, todos).filter(function (child) { return child.archived != 1 && child.completed != 1; });
        if (!descendants.length) return getEffectivePriority(todo);
        return descendants.reduce(function (best, child) {
            return priorityLevel(getEffectivePriority(child)) > priorityLevel(best) ? getEffectivePriority(child) : best;
        }, 'anytime');
    }
    function hasChildren(todo) { return childrenOf(todo.id, todos).length > 0; }
    function previousSibling(todo) {
        var siblings = childrenOf(parentIdOf(todo), todos.filter(function (item) { return item.archived != 1; }));
        var index = siblings.findIndex(function (item) { return sameId(item.id, todo.id); });
        return index > 0 ? siblings[index - 1] : null;
    }
    function breadcrumb(todo) {
        var parts = [], current = todo, seen = {};
        while (current && !seen[String(current.id)]) {
            seen[String(current.id)] = true;
            parts.unshift(current.title);
            current = todos.find(function (item) { return sameId(item.id, current.parent_id); });
        }
        parts.pop();
        return parts.length ? parts.join(' / ') : '';
    }
    function taskOptionLabel(todo, depth) {
        var path = breadcrumb(todo);
        var status = todo.completed == 1 ? '已完成' : (isBlocked(todo) ? '等待前置' : '可执行');
        var suffix = path ? ' · ' + path : '';
        return Array(depth + 1).join('　') + todo.title + suffix + ' · #' + todo.id + ' · ' + status;
    }
    function parentOptions(currentId, selectedId) {
        var excluded = {};
        if (currentId) {
            excluded[String(currentId)] = true;
            descendantLeaves(currentId, todos).forEach(function (leaf) { excluded[String(leaf.id)] = true; });
            function excludeBranches(id) {
                childrenOf(id, todos).forEach(function (child) {
                    excluded[String(child.id)] = true;
                    excludeBranches(child.id);
                });
            }
            excludeBranches(currentId);
        }
        var html = '<option value="">顶层任务</option>';
        taskOptionRows().forEach(function (row) {
            var id = String(row.todo.id);
            if (excluded[id]) return;
            html += '<option value="' + id + '"' + (sameId(id, selectedId) ? ' selected' : '') + '>' +
                escapeHtml(taskOptionLabel(row.todo, row.depth)) + '</option>';
        });
        return html;
    }
    function dependencyOptions(currentId, selectedIds) {
        var selected = (selectedIds || []).map(String);
        var excluded = {};
        if (currentId) {
            excluded[String(currentId)] = true;
            descendantTasks(currentId, todos).forEach(function (task) { excluded[String(task.id)] = true; });
        }
        var html = '';
        taskOptionRows().forEach(function (row) {
            var id = String(row.todo.id);
            if (excluded[id]) return;
            html += '<option value="' + id + '"' + (selected.indexOf(id) !== -1 ? ' selected' : '') + '>' +
                escapeHtml(taskOptionLabel(row.todo, row.depth)) + '</option>';
        });
        return html || '<option value="" disabled>请先添加其他任务</option>';
    }
    function populateParentSelect() {
        var select = document.getElementById('todo-parent');
        if (select) select.innerHTML = parentOptions('', pendingParentId);
    }
    function updateDependencyPickerSelection() {
        var select = document.getElementById('todo-dependencies');
        var options = document.getElementById('todo-dependencies-options');
        var count = document.getElementById('todo-dependencies-count');
        if (!select || !options) return;
        var selected = {};
        Array.from(select.selectedOptions).forEach(function (option) { selected[String(option.value)] = true; });
        options.querySelectorAll('.todo-task-picker-option').forEach(function (button) {
            var isSelected = !!selected[String(button.dataset.value)];
            button.classList.toggle('selected', isSelected);
            button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });
        if (count) count.textContent = Object.keys(selected).length ? Object.keys(selected).length + ' 个已选择' : '未选择';
    }
    function filterDependencyPicker() {
        var input = document.getElementById('todo-dependencies-search');
        var query = input ? input.value.trim().toLowerCase() : '';
        document.querySelectorAll('#todo-dependencies-options .todo-task-picker-option').forEach(function (button) {
            button.hidden = !!query && button.dataset.search.indexOf(query) === -1;
        });
    }
    function bindDependencyPicker() {
        var input = document.getElementById('todo-dependencies-search');
        if (input && !input.dataset.bound) {
            input.dataset.bound = 'true';
            input.addEventListener('input', filterDependencyPicker);
        }
    }
    function renderDependencyPicker() {
        var select = document.getElementById('todo-dependencies');
        var options = document.getElementById('todo-dependencies-options');
        if (!select || !options) return;
        var oldQuery = document.getElementById('todo-dependencies-search');
        var query = oldQuery ? oldQuery.value : '';
        var html = '';
        Array.from(select.options).forEach(function (option) {
            if (!option.value) return;
            var text = option.textContent.trim();
            var match = text.match(/^(.*)\s·\s#([^\s]+)\s·\s(.*)$/);
            var title = match ? match[1] : text;
            var meta = match ? '#' + match[2] + ' · ' + match[3] : '前置任务';
            var search = text.toLowerCase();
            html += '<button type="button" class="todo-task-picker-option" role="option" data-value="' + escapeAttribute(option.value) + '" data-search="' + escapeAttribute(search) + '" aria-selected="false">' +
                '<span class="todo-task-picker-check" aria-hidden="true">✓</span><span class="todo-task-picker-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(meta) + '</small></span></button>';
        });
        options.innerHTML = html || '<div class="todo-task-picker-empty">暂时没有可作为前置的任务</div>';
        options.querySelectorAll('.todo-task-picker-option').forEach(function (button) {
            button.addEventListener('click', function () {
                var target = Array.from(select.options).find(function (option) { return String(option.value) === String(button.dataset.value); });
                if (!target) return;
                target.selected = !target.selected;
                pendingDependencies = Array.from(select.selectedOptions).map(function (option) { return option.value; });
                updateDependencyPickerSelection();
            });
        });
        bindDependencyPicker();
        updateDependencyPickerSelection();
        if (oldQuery) oldQuery.value = query;
        filterDependencyPicker();
    }
    function populateDependenciesSelect() {
        var select = document.getElementById('todo-dependencies');
        if (select) {
            select.innerHTML = dependencyOptions('', pendingDependencies);
            renderDependencyPicker();
        }
    }
    function setNewParent(id) {
        pendingParentId = id ? String(id) : '';
        populateParentSelect();
        var input = document.getElementById('todo-input');
        if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    function addChild(id) { setNewParent(id); }
    function toggleCollapse(id) {
        var key = String(id);
        if (collapsedIds[key]) delete collapsedIds[key]; else collapsedIds[key] = true;
        saveCollapsedIds(); render();
    }
    function updateParent(todo, parentId) {
        if (!beginMutation(todo.id)) return;
        var snapshot = snapshotTodos();
        todo.parent_id = parentId ? String(parentId) : null;
        todo.sort_order = -1;
        saveToLocal(); render();
        ajax('todo_update', { id: todo.id, parent_id: parentId || '' }).then(function () {
            endMutation(todo.id); return syncFromServer(true).catch(function () { showMessage('层级已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(todo.id); restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '任务层级保存失败，已恢复原关系。', 'error');
        });
    }
    function indentTodo(id) {
        var todo = todos.find(function (item) { return sameId(item.id, id); });
        var previous = todo && previousSibling(todo);
        if (todo && previous) updateParent(todo, previous.id);
    }
    function outdentTodo(id) {
        var todo = todos.find(function (item) { return sameId(item.id, id); });
        var parent = todo && todos.find(function (item) { return sameId(item.id, todo.parent_id); });
        if (todo && parent) updateParent(todo, parent.parent_id || '');
    }

    /* ========== CRUD ========== */
    function addTodo() {
        var input = document.getElementById('todo-input');
        var title = input.value.trim();
        if (!title) { showMessage('请先填写任务名称。', 'error'); input.focus(); return; }
        if (createBusy) return;
        createBusy = true;
        var priority = document.getElementById('todo-priority').value;
        var dueDate = document.getElementById('todo-date').value;
        var importance = parseInt(document.getElementById('todo-importance').value) || 3;
        var parentId = document.getElementById('todo-parent').value || pendingParentId;
        var notes = document.getElementById('todo-notes').value.trim();
        var dependenciesEl = document.getElementById('todo-dependencies');
        var dependencies = dependenciesEl ? Array.from(dependenciesEl.selectedOptions).map(function (option) { return option.value; }) : pendingDependencies.slice();

        var tempId = 'temp_' + Date.now();
        var tempTodo = {
            id: tempId, title: title, completed: 0, archived: 0, priority: priority,
            importance: importance, due_date: dueDate || null, sort_order: 0,
            parent_id: parentId || null, notes: notes, dependencies: dependencies,
            created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
        };
        todos.unshift(tempTodo); saveToLocal(); render();
        input.value = ''; document.getElementById('todo-date').value = ''; document.getElementById('todo-notes').value = ''; input.focus();

        ajax('todo_create', { title: title, priority: priority, due_date: dueDate, importance: importance, parent_id: parentId, notes: notes, dependencies: JSON.stringify(dependencies) })
            .then(function (row) {
                createBusy = false;
                var idx = todos.findIndex(function (t) { return t.id === tempId; });
                if (idx !== -1) todos[idx] = row;
                pendingParentId = ''; pendingDependencies = [];
                saveToLocal(); render(); syncFromServer(true).catch(function () { });
            })
            .catch(function (error) {
                createBusy = false;
                todos = todos.filter(function (t) { return t.id !== tempId; });
                pendingParentId = parentId || ''; pendingDependencies = dependencies.slice();
                saveToLocal(); render();
                input.value = title;
                document.getElementById('todo-date').value = dueDate;
                document.getElementById('todo-notes').value = notes;
                document.getElementById('todo-priority').value = priority;
                document.getElementById('todo-importance').value = String(importance);
                var importanceLabel = document.getElementById('todo-importance-label');
                if (importanceLabel) importanceLabel.textContent = importanceStars(importance);
                showMessage(typeof error === 'string' ? error : '保存待办失败，请检查归属任务和前置任务是否有效。', 'error');
            });
    }

    function toggleTodo(id) {
        var todo = todos.find(function (t) { return t.id == id; });
        if (!todo || todo.archived == 1 || !beginMutation(id)) return;
        var snapshot = snapshotTodos();
        todo.completed = todo.completed == 1 ? 0 : 1;
        saveToLocal(); render();
        ajax('todo_update', { id: id, completed: todo.completed }).then(function () {
            endMutation(id); return syncFromServer(true).catch(function () { showMessage('完成状态已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(id); restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '完成状态保存失败，已恢复原状态。', 'error');
        });
    }

    function archiveTodo(id) {
        var todo = todos.find(function (t) { return t.id == id; });
        if (!todo || todo.archived == 1 || !beginMutation(id)) return;
        var snapshot = snapshotTodos();
        todo.archived = 1;
        todo.archived_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
        saveToLocal(); render();
        ajax('todo_update', { id: id, archived: 1 }).then(function () {
            endMutation(id); return syncFromServer(true).catch(function () { showMessage('归档已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(id); restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '归档失败，已恢复原状态。', 'error');
        });
    }

    function restoreTodo(id) {
        var todo = todos.find(function (t) { return t.id == id; });
        if (!todo || todo.archived != 1 || !beginMutation(id)) return;
        var snapshot = snapshotTodos();
        todo.archived = 0;
        todo.archived_at = null;
        saveToLocal(); render();
        ajax('todo_update', { id: id, archived: 0 }).then(function () {
            endMutation(id); return syncFromServer(true).catch(function () { showMessage('恢复已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(id); restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '恢复失败，已恢复原状态。', 'error');
        });
    }

    function deleteTodo(id) {
        if (!confirm('确定删除这条待办？')) return;
        if (!beginMutation(id)) return;
        var snapshot = snapshotTodos();
        var target = todos.find(function (todo) { return sameId(todo.id, id); });
        var promotedParent = target ? parentIdOf(target) : '';
        todos.forEach(function (todo) {
            if (sameId(todo.parent_id, id)) todo.parent_id = promotedParent || null;
            todo.dependencies = dependencyIdsOf(todo).filter(function (dependencyId) { return !sameId(dependencyId, id); });
        });
        todos = todos.filter(function (t) { return t.id != id; });
        saveToLocal(); render();
        ajax('todo_delete', { id: id }).then(function () {
            endMutation(id); return syncFromServer(true).catch(function () { showMessage('删除已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(id); restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '删除失败，已恢复任务及其关系。', 'error');
        });
    }

    function startEdit(id) { editingId = id; render(); var el = document.getElementById('edit-title-' + id); if (el) { el.focus(); el.select(); } }
    function editFromDag(id) { setView('list'); startEdit(id); }

    function saveEdit(id) {
        if (!beginMutation(id)) return;
        var el = document.getElementById('edit-title-' + id);
        var priorityEl = document.getElementById('edit-priority-' + id);
        var dateEl = document.getElementById('edit-date-' + id);
        var impEl = document.getElementById('edit-importance-' + id);
        var notesEl = document.getElementById('edit-notes-' + id);
        var parentEl = document.getElementById('edit-parent-' + id);
        var dependenciesEl = document.getElementById('edit-dependencies-' + id);
        var todo = todos.find(function (t) { return t.id == id; });
        if (!todo) { endMutation(id); return; }
        var snapshot = snapshotTodos();
        var data = { id: id };
        var newTitle = el ? el.value.trim() : todo.title;
        todo.title = newTitle || todo.title; data.title = todo.title;
        if (priorityEl) { todo.priority = priorityEl.value; data.priority = priorityEl.value; }
        if (dateEl) { todo.due_date = dateEl.value || null; data.due_date = dateEl.value || ''; }
        if (impEl) { todo.importance = parseInt(impEl.value) || 3; data.importance = todo.importance; }
        if (notesEl) { todo.notes = notesEl.value.trim(); data.notes = todo.notes; }
        if (parentEl) { todo.parent_id = parentEl.value || null; data.parent_id = parentEl.value || ''; }
        if (dependenciesEl) {
            todo.dependencies = Array.from(dependenciesEl.selectedOptions).map(function (option) { return option.value; });
            data.dependencies = JSON.stringify(todo.dependencies);
        }
        editingId = null; saveToLocal(); render();
        ajax('todo_update', data).then(function () {
            endMutation(id); return syncFromServer(true).catch(function () { showMessage('编辑已保存，但刷新任务列表失败。', 'error'); });
        }).catch(function (error) {
            endMutation(id); restoreSnapshot(snapshot); editingId = null;
            showMessage(typeof error === 'string' ? error : '编辑保存失败，已恢复原任务。', 'error');
        });
    }

    function cancelEdit() { editingId = null; render(); }
    function setFilter(f) {
        currentFilter = ['all', 'active', 'completed', 'archived'].indexOf(f) !== -1 ? f : 'all';
        savePreference(FILTER_KEY, currentFilter);
        if (currentFilter === 'archived' && currentView === 'chart') {
            setView('list');
            return;
        }
        render();
    }
    function setView(v) {
        if (['list', 'focus', 'dag', 'chart'].indexOf(v) === -1) v = 'list';
        currentView = v;
        savePreference(VIEW_KEY, currentView);
        document.querySelectorAll('.todo-view-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
        document.getElementById('todo-list').style.display = (v === 'list' || v === 'focus') ? '' : 'none';
        document.getElementById('todo-dag-wrap').style.display = v === 'dag' ? '' : 'none';
        document.getElementById('todo-matrix-wrap').style.display = v === 'chart' ? '' : 'none';
        // 两种视图都保留宽屏空间，列表可排列多张卡片。
        var mainMain = document.querySelector('.main-main');
        if (mainMain) mainMain.classList.add('todo-wide-mode');
        render();
    }

    /* ========== 拖拽 ========== */
    function clearDragDropState() {
        document.body.classList.remove('todo-dragging');
        document.querySelectorAll('.todo-parent-drop-zone.active, .todo-root-drop-zone.active').forEach(function (zone) { zone.classList.remove('active'); });
        if (dragItem) dragItem.classList.remove('dragging');
        dragDropTarget = null;
    }
    function canDropOnParent(todoId, parentId) {
        if (!todoId || !parentId || String(todoId) === String(parentId)) return false;
        return !descendantTasks(todoId, todos).some(function (task) { return String(task.id) === String(parentId); });
    }
    function findDraggedTodo() {
        if (!dragItem) return null;
        return todos.find(function (todo) { return String(todo.id) === String(dragItem.dataset.id); }) || null;
    }
    function handleDragStart(e) {
        dragSnapshot = snapshotTodos();
        dragReparented = false;
        dragItem = e.currentTarget;
        dragItem.classList.add('dragging');
        document.body.classList.add('todo-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragItem.dataset.id || '');
    }
    function handleDragOver(e) {
        e.preventDefault();
        if (e.target.closest('.todo-parent-drop-zone, .todo-root-drop-zone')) return;
        var target = e.target.closest('.todo-item, .todo-child-card');
        var isChildDrag = dragItem && dragItem.classList.contains('todo-child-card');
        var dragContainer = isChildDrag ? dragItem : dragItem.closest('.todo-main-card');
        var targetContainer = target && (isChildDrag ? target : target.closest('.todo-main-card'));
        var list = dragContainer && dragContainer.parentElement;
        if (target && target !== dragItem && target.dataset.parentId === dragItem.dataset.parentId && targetContainer && targetContainer.parentElement === list) {
            var items = Array.from(list.children).filter(function (item) { return isChildDrag ? item.matches('.todo-child-card') : item.matches('.todo-main-card'); });
            if (items.indexOf(dragContainer) < items.indexOf(targetContainer)) list.insertBefore(dragContainer, targetContainer.nextSibling);
            else list.insertBefore(dragContainer, targetContainer);
        }
    }
    function handleParentDragOver(e) {
        var zone = e.currentTarget;
        var dragged = findDraggedTodo();
        var parentId = zone.dataset.parentDropId;
        if (!dragged || !canDropOnParent(dragged.id, parentId)) return;
        e.preventDefault();
        e.stopPropagation();
        dragDropTarget = { zone: zone, parentId: parentId };
        document.querySelectorAll('.todo-parent-drop-zone.active').forEach(function (item) { if (item !== zone) item.classList.remove('active'); });
        zone.classList.add('active');
        e.dataTransfer.dropEffect = 'move';
    }
    function handleRootDragOver(e) {
        var dragged = findDraggedTodo();
        if (!dragged || !parentIdOf(dragged)) return;
        e.preventDefault();
        e.stopPropagation();
        dragDropTarget = { zone: e.currentTarget, parentId: '' };
        e.currentTarget.classList.add('active');
        e.dataTransfer.dropEffect = 'move';
    }
    function handleParentDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        var dragged = findDraggedTodo();
        var parentId = e.currentTarget.dataset.parentDropId;
        if (!dragged || !canDropOnParent(dragged.id, parentId)) return;
        dragReparented = true;
        clearDragDropState();
        updateParent(dragged, parentId);
    }
    function handleRootDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        var dragged = findDraggedTodo();
        if (!dragged || !parentIdOf(dragged)) return;
        dragReparented = true;
        clearDragDropState();
        updateParent(dragged, '');
    }
    function handleDragEnd() {
        var wasReparented = dragReparented;
        clearDragDropState();
        dragItem = null;
        if (wasReparented) { dragSnapshot = null; return; }
        var list = document.getElementById('todo-list');
        var orders = [];
        var counters = {};
        Array.from(list.querySelectorAll('.todo-item[data-id], .todo-child-card[data-id]')).forEach(function (item) {
            var id = item.dataset.id; var todo = todos.find(function (t) { return t.id == id; });
            if (todo) {
                var parentId = item.dataset.parentId || '';
                counters[parentId] = counters[parentId] || 0;
                todo.sort_order = counters[parentId]++;
                orders.push({ id: id, parent_id: parentId, sort_order: todo.sort_order });
            }
        });
        var snapshot = dragSnapshot || snapshotTodos();
        dragSnapshot = null;
        saveToLocal();
        ajax('todo_reorder', { orders: JSON.stringify(orders) }).then(function () { return syncFromServer(true).catch(function () { showMessage('排序已保存，但刷新任务列表失败。', 'error'); }); }).catch(function (error) {
            restoreSnapshot(snapshot);
            showMessage(typeof error === 'string' ? error : '排序保存失败，已恢复原顺序。', 'error');
        });
    }

    /* ========== 渲染 ========== */
    function matchesSearch(todo) {
        if (!searchQuery) return true;
        var haystack = [todo.title, todo.notes, breadcrumb(todo)].join(' ').toLowerCase();
        return haystack.indexOf(searchQuery.toLowerCase()) !== -1;
    }
    function getFilteredTodos() {
        return todos.filter(function (t) {
            var archived = t.archived == 1;
            if (!matchesSearch(t)) return false;
            if (currentFilter === 'archived') return archived;
            if (archived) return false;
            if (currentFilter === 'active') return t.completed == 0;
            if (currentFilter === 'completed') return t.completed == 1;
            return true;
        });
    }

    function render() {
        var filtered = getFilteredTodos();
        var visibleTodos = todos.filter(function (t) { return t.archived != 1; });
        var total = visibleTodos.length;
        var done = visibleTodos.filter(function (t) { return t.completed == 1; }).length;
        var archived = todos.filter(function (t) { return t.archived == 1; }).length;
        var percent = total > 0 ? Math.round(done / total * 100) : 0;

        var stats = document.getElementById('todo-stats');
        if (stats) stats.innerHTML = '<span>共 ' + total + ' 项</span><span>待完成 ' + (total - done) + '</span><span>已完成 ' + done + '</span><span>已归档 ' + archived + '</span><span>' + percent + '%</span>' + (searchQuery ? '<span>搜索：' + escapeHtml(searchQuery) + '</span>' : '');
        var pb = document.getElementById('todo-progress-bar'); if (pb) pb.style.width = percent + '%';
        document.querySelectorAll('.todo-filter-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.filter === currentFilter); });
        populateParentSelect();
        populateDependenciesSelect();

        if (currentView === 'list') renderList(filtered);
        else if (currentView === 'focus') renderFocus(filtered);
        else if (currentView === 'dag') renderDag(filtered);
        else { renderChart(filtered); renderSidebar(filtered); }
    }

    /* ========== 侧边栏：按象限分类 ========== */
    function renderSidebar(filtered) {
        var sidebar = document.getElementById('todo-sidebar');
        if (!sidebar) return;

        var IMP_SPLIT = 3.2;
        var groups = {
            do_now:   { label: '&#128308; 立即做', items: [] },
            do_fast:  { label: '&#128992; 快速做', items: [] },
            plan:     { label: '&#128993; 计划做', items: [] },
            general:  { label: '&#128994; 一般事务', items: [] }
        };

        filtered.forEach(function (todo) {
            if (todo.completed == 1) return;
            var days = getDaysRemaining(todo.due_date);
            var imp = getEffectiveImportance(todo);
            var urgent = (days !== null && days <= 3.2);
            // 计划做阈值：x>14时沿升星斜线
            var daysVal = (days === null) ? 21 : Math.max(-3, Math.min(21, days));
            var impThreshold = daysVal > 14 ? 3 + (daysVal - 14) / 7 * 0.5 : IMP_SPLIT;

            if (urgent && imp >= IMP_SPLIT) groups.do_now.items.push(todo);
            else if (urgent && imp < IMP_SPLIT) groups.do_fast.items.push(todo);
            else if (imp >= impThreshold) groups.plan.items.push(todo);
            else groups.general.items.push(todo);
        });

        var html = '';
        ['do_now', 'do_fast', 'plan', 'general'].forEach(function (key) {
            var g = groups[key];
            html += '<div class="todo-sidebar-group">';
            html += '<div class="todo-sidebar-title">' + g.label + ' <span class="todo-sidebar-count">' + g.items.length + '</span></div>';
            if (g.items.length === 0) {
                html += '<div class="todo-sidebar-empty">- 无 -</div>';
            } else {
                g.items.forEach(function (todo) {
                    var effP = hasChildren(todo) ? treePriority(todo) : getEffectivePriority(todo);
                    var css = priorityCss(effP);
                    html += '<div class="todo-sidebar-item">';
                    html += '<span class="todo-sidebar-dot ' + css + '"></span>';
                    html += '<button class="todo-sidebar-play" onclick="window._todo.startPomodoro(' + todo.id + ')" title="番茄钟">&#9654;</button>';
                    html += '<span class="todo-sidebar-text">' + escapeHtml(todo.title) + '</span>';
                    if (todo.due_date) {
                        var d = getDaysRemaining(todo.due_date);
                        var dText = d < 0 ? '过期' + Math.abs(d) + '天' : d === 0 ? '今天' : d + '天';
                        html += '<span class="todo-sidebar-due">' + dText + '</span>';
                    }
                    var pc = getPomodoroCount(todo.id);
                    var pm = getPomodoroMinutes(todo.id);
                    if (pc > 0 || pm > 0) {
                        var parts = [];
                        if (pc > 0) parts.push('&#127813;' + pc);
                        if (pm > 0) parts.push(formatMinutes(pm));
                        html += '<span class="todo-sidebar-pomodoro">' + parts.join(' &middot; ') + '</span>';
                    }
                    html += '</div>';
                });
            }
            html += '</div>';
        });

        sidebar.innerHTML = html;
    }

    function renderTaskCard(todo, depth, focusMode) {
        var isEditing = editingId == todo.id;
        var children = childrenOf(todo.id, todos);
        var hasChildTasks = children.length > 0;
        var treeP = hasChildTasks ? treePriority(todo) : getEffectivePriority(todo);
        var effCss = priorityCss(treeP);
        var upgraded = treeP !== (todo.priority || 'thisweek') && todo.completed != 1;
        var isArchived = todo.archived == 1;
        var previous = previousSibling(todo);
        var itemId = todo.id;
        var actionId = /^\d+$/.test(String(itemId)) ? String(itemId) : "'" + escapeAttribute(itemId) + "'";
        var html = '<div class="todo-item todo-tree-item' + (isEditing ? ' editing' : '') + (todo.completed == 1 ? ' completed' : '') + (isArchived ? ' archived' : '') + (collapsedIds[String(itemId)] ? ' collapsed' : '') + (isPomodoring(itemId) ? ' pomodoro-active' : '') + '" data-id="' + itemId + '" data-parent-id="' + parentIdOf(todo) + '" style="--todo-depth:' + (depth || 0) + ';" draggable="' + (!isEditing && !focusMode) + '">';
        html += '<div class="todo-priority-bar ' + effCss + '"></div><div class="todo-body">';
        html += '<div class="todo-checkbox' + (isArchived ? ' disabled' : '') + '"' + (isArchived ? '' : ' onclick="window._todo.toggle(' + actionId + ')"') + '></div>';
        html += '<div class="todo-content">';
        if (isEditing) {
            html += '<input class="todo-title-input" id="edit-title-' + itemId + '" value="' + escapeAttribute(todo.title) + '" onkeydown="if(event.key===\'Enter\')window._todo.saveEdit(' + actionId + ');if(event.key===\'Escape\')window._todo.cancelEdit()">';
            html += '<div class="todo-edit-inline">';
            html += '<select id="edit-priority-' + itemId + '"><option value="urgent"' + (todo.priority === 'urgent' || todo.priority === 'high' ? ' selected' : '') + '>紧急</option><option value="twodays"' + (todo.priority === 'twodays' ? ' selected' : '') + '>这两天</option><option value="thisweek"' + (todo.priority === 'thisweek' || todo.priority === 'medium' ? ' selected' : '') + '>这周处理</option><option value="anytime"' + (todo.priority === 'anytime' || todo.priority === 'low' ? ' selected' : '') + '>随时可以</option></select>';
            html += '<select id="edit-importance-' + itemId + '">';
            for (var i = 5; i >= 1; i--) html += '<option value="' + i + '"' + (parseInt(todo.importance) === i ? ' selected' : '') + '>' + importanceStars(i) + '</option>';
            html += '</select><input type="date" id="edit-date-' + itemId + '" value="' + escapeAttribute(todo.due_date || '') + '">';
            html += '<select id="edit-parent-' + itemId + '">' + parentOptions(itemId, parentIdOf(todo)) + '</select>';
            html += '<select id="edit-dependencies-' + itemId + '" class="todo-dependencies-select" multiple size="2">' + dependencyOptions(itemId, dependencyIdsOf(todo)) + '</select>';
            html += '</div><textarea class="todo-edit-notes" id="edit-notes-' + itemId + '" rows="2" placeholder="备注">' + escapeHtml(todo.notes || '') + '</textarea>';
            html += '<div class="todo-edit-actions"><button class="todo-action-btn" onclick="window._todo.saveEdit(' + actionId + ')" title="保存">&#10003;</button><button class="todo-action-btn" onclick="window._todo.cancelEdit()" title="取消">&#10005;</button></div>';
        } else {
            if (focusMode) {
                var path = breadcrumb(todo);
                if (path) html += '<div class="todo-breadcrumb">' + escapeHtml(path) + '</div>';
            }
            html += '<div class="todo-title">' + escapeHtml(todo.title) + '</div>';
            if (todo.notes) html += '<div class="todo-notes-preview">' + escapeHtml(todo.notes) + '</div>';
            html += '<div class="todo-meta"><span class="todo-priority-tag ' + effCss + '">' + priorityLabel(treeP) + (upgraded ? ' ↑' : '') + '</span>';
            if (hasChildTasks) {
                var progress = treeProgress(todo);
                var nextChild = nextAvailableChild(todo);
                if (progress) html += '<span class="todo-progress-tag">' + progress.done + ' / ' + progress.total + ' 已完成</span>';
                if (treeP !== (todo.priority || 'thisweek')) html += '<span class="todo-inherited-priority">子任务最高：' + priorityLabel(treeP) + '</span>';
                if (nextChild) html += '<span class="todo-next-badge">下一步：' + escapeHtml(nextChild.title) + '</span>';
            } else {
                html += '<span class="todo-importance-tag">' + importanceStars(todo.importance) + '</span>';
            }
            html += pomodoroCountHtml(itemId);
            if (todo.due_date) html += '<span class="todo-due"><span class="todo-due-icon">&#128197;</span>' + formatDate(todo.due_date) + '</span>' + getCountdownHtml(todo);
            html += '</div>';
        }
        html += '</div>';
        if (!isEditing) {
            html += '<div class="todo-actions">';
            if (hasChildTasks) html += '<button class="todo-action-btn collapse" onclick="window._todo.collapse(' + actionId + ')" title="' + (collapsedIds[String(itemId)] ? '展开子任务' : '折叠子任务') + '">' + (collapsedIds[String(itemId)] ? '&#9656;' : '&#9662;') + '</button>';
            if (!isArchived) {
                html += '<button class="todo-action-btn child" onclick="window._todo.addChild(' + actionId + ')" title="新建子任务">&#8627;</button>';
                if (parentIdOf(todo)) html += '<button class="todo-action-btn" onclick="window._todo.outdent(' + actionId + ')" title="提升层级">&#8676;</button>';
                if (previous) html += '<button class="todo-action-btn" onclick="window._todo.indent(' + actionId + ')" title="降低层级">&#8677;</button>';
            }
            if (isArchived) html += '<button class="todo-action-btn restore" onclick="window._todo.restore(' + actionId + ')" title="恢复到列表">&#8635;</button>';
            else {
                if (todo.completed != 1) html += '<button class="todo-action-btn pomodoro" onclick="window._todo.startPomodoro(' + actionId + ')" title="番茄钟">&#9654;</button>';
                html += '<button class="todo-action-btn" onclick="window._todo.startEdit(' + actionId + ')" title="编辑">&#9998;</button><button class="todo-action-btn archive" onclick="window._todo.archive(' + actionId + ')" title="归档">&#128451;</button>';
            }
            html += '<button class="todo-action-btn delete" onclick="window._todo.deleteTodo(' + actionId + ')" title="删除">&#128465;</button></div>';
        }
        if (!isEditing && !focusMode && !isArchived) {
            html += '<div class="todo-parent-drop-zone" data-parent-drop-id="' + escapeAttribute(itemId) + '">放到这里，成为此任务的子任务</div>';
        }
        return html + '</div></div>';
    }

    function renderChildCard(todo, isNext, depth) {
        depth = depth || 1;
        if (editingId == todo.id) {
            return '<div class="todo-child-node" style="--todo-child-depth:' + depth + ';"><div class="todo-child-editing">' + renderTaskCard(todo, depth, false) + '</div></div>';
        }
        var actionId = /^\d+$/.test(String(todo.id)) ? String(todo.id) : "'" + escapeAttribute(todo.id) + "'";
        var blocked = isBlocked(todo);
        var deps = dependencyNames(todo);
        var isArchived = todo.archived == 1;
        var previous = previousSibling(todo);
        var html = '<div class="todo-child-node" style="--todo-child-depth:' + depth + ';"><div class="todo-child-card' + (todo.completed == 1 ? ' completed' : '') + (blocked ? ' blocked' : '') + '" data-id="' + escapeAttribute(todo.id) + '" data-parent-id="' + parentIdOf(todo) + '" draggable="true">';
        html += '<div class="todo-priority-bar ' + priorityCss(getEffectivePriority(todo)) + '"></div>';
        html += '<div class="todo-checkbox' + (isArchived ? ' disabled' : '') + '"' + (isArchived ? '' : ' onclick="window._todo.toggle(' + actionId + ')"') + '></div>';
        html += '<div class="todo-child-content"><div class="todo-child-title">' + escapeHtml(todo.title) + '</div>';
        if (todo.notes) html += '<div class="todo-child-notes">' + escapeHtml(todo.notes) + '</div>';
        html += '<div class="todo-child-meta">';
        html += '<span class="todo-priority-tag ' + priorityCss(getEffectivePriority(todo)) + '">' + priorityLabel(getEffectivePriority(todo)) + '</span>';
        if (isNext && todo.completed != 1) html += '<span class="todo-next-badge">下一步</span>';
        if (blocked) html += '<span class="todo-blocked-tag">等待：' + escapeHtml(deps.join('、')) + '</span>';
        if (todo.due_date) html += '<span>' + formatDate(todo.due_date) + '</span>';
        html += '</div></div><div class="todo-child-actions">';
        if (!isArchived) {
            if (parentIdOf(todo)) html += '<button class="todo-action-btn" onclick="window._todo.outdent(' + actionId + ')" title="提升层级">&#8676;</button>';
            if (previous) html += '<button class="todo-action-btn" onclick="window._todo.indent(' + actionId + ')" title="降低层级">&#8677;</button>';
            html += '<button class="todo-action-btn" onclick="window._todo.addChild(' + actionId + ')" title="新建子任务">&#8627;</button>';
            html += '<button class="todo-action-btn" onclick="window._todo.startEdit(' + actionId + ')" title="编辑">&#9998;</button>';
            if (todo.completed != 1) html += '<button class="todo-action-btn" onclick="window._todo.startPomodoro(' + actionId + ')" title="番茄钟">&#9654;</button>';
            html += '<button class="todo-action-btn" onclick="window._todo.archive(' + actionId + ')" title="归档">&#128451;</button><button class="todo-action-btn" onclick="window._todo.deleteTodo(' + actionId + ')" title="删除">&#128465;</button>';
        }
        html += '</div>';
        var children = childPreview(todo);
        if (children.length) {
            var nextChild = nextAvailableChild(todo);
            var visibleChildren = children.slice(0, 3);
            html += '<div class="todo-child-list todo-child-list-nested">' + visibleChildren.map(function (child) {
                return renderChildCard(child, nextChild && sameId(nextChild.id, child.id), depth + 1);
            }).join('');
            if (children.length > visibleChildren.length) {
                html += '<div class="todo-more-children">还有 ' + (children.length - visibleChildren.length) + ' 个子任务</div>';
            }
            html += '</div>';
        }
        if (!isArchived) {
            html += '<div class="todo-parent-drop-zone" data-parent-drop-id="' + escapeAttribute(todo.id) + '">放到这里，成为子任务</div>';
        }
        return html + '</div>';
    }

    function renderMainCard(todo) {
        var children = childPreview(todo);
        var nextChild = nextAvailableChild(todo);
        var visibleChildren = children.slice(0, 3);
        var cardClass = visibleChildren.length ? ' has-children' : ' single-task';
        var html = '<div class="todo-main-card' + cardClass + '">' + renderTaskCard(todo, 0, false);
        if (visibleChildren.length) {
            html += '<div class="todo-child-list">' + visibleChildren.map(function (child) {
                return renderChildCard(child, nextChild && sameId(nextChild.id, child.id), 1);
            }).join('');
            if (children.length > visibleChildren.length) {
                html += '<div class="todo-more-children">还有 ' + (children.length - visibleChildren.length) + ' 个子任务，完成当前步骤后继续展开</div>';
            }
            html += '</div>';
        }
        return html + '</div>';
    }

    function rootHasFilterMatch(root) {
        return getFilteredTodos().some(function (todo) {
            return sameId(todo.id, root.id) || descendantTasks(root.id, todos).some(function (task) { return sameId(task.id, todo.id); });
        });
    }

    function attachTreeDragHandlers(listEl) {
        listEl.querySelectorAll('.todo-item[draggable="true"], .todo-child-card[draggable="true"]').forEach(function (item) {
            item.addEventListener('dragstart', handleDragStart);
            item.addEventListener('dragover', handleDragOver);
            item.addEventListener('dragend', handleDragEnd);
        });
        listEl.querySelectorAll('.todo-parent-drop-zone').forEach(function (zone) {
            zone.addEventListener('dragover', handleParentDragOver);
            zone.addEventListener('drop', handleParentDrop);
        });
        var rootZone = listEl.querySelector('.todo-root-drop-zone');
        if (rootZone) {
            rootZone.addEventListener('dragover', handleRootDragOver);
            rootZone.addEventListener('drop', handleRootDrop);
        }
    }

    function renderList(filtered) {
        var listEl = document.getElementById('todo-list');
        listEl.classList.add('todo-tree-list');
        if (currentFilter === 'archived') {
            var archivedRows = treeRows(filtered, true);
            if (archivedRows.length === 0) {
                listEl.innerHTML = '<div class="todo-empty"><div class="todo-empty-icon">&#128203;</div>还没有已归档的事项</div>';
                return;
            }
            listEl.innerHTML = archivedRows.map(function (row) { return renderTaskCard(row.todo, row.depth, false); }).join('');
            attachTreeDragHandlers(listEl);
            return;
        }
        var roots = todos.filter(function (todo) {
            return todo.archived != 1 && !parentIdOf(todo) && rootHasFilterMatch(todo);
        }).sort(function (a, b) {
            return (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0);
        });
        if (roots.length === 0) {
            var emptyText = searchQuery ? '没有匹配的任务' : (currentFilter === 'all' ? '暂无待办事项，添加一个吧' : currentFilter === 'active' ? '所有任务都完成了！' : currentFilter === 'completed' ? '还没有已完成的待办' : '还没有已归档的事项');
            listEl.innerHTML = '<div class="todo-empty"><div class="todo-empty-icon">&#128203;</div>' + emptyText + '</div>';
            return;
        }
        listEl.innerHTML = '<div class="todo-root-drop-zone">拖到这里，提升为顶层任务</div>' + roots.map(renderMainCard).join('');
        attachTreeDragHandlers(listEl);
    }

    function renderFocus() {
        var listEl = document.getElementById('todo-list');
        listEl.classList.add('todo-tree-list', 'todo-focus-list');
        var visible = getFilteredTodos();
        var leaves = visible.filter(function (todo) {
            return todo.archived != 1 && todo.completed != 1 && !hasChildren(todo) && !isBlocked(todo);
        }).sort(function (a, b) {
            var priority = priorityLevel(getEffectivePriority(b)) - priorityLevel(getEffectivePriority(a));
            if (priority) return priority;
            var ad = a.due_date || '9999-12-31', bd = b.due_date || '9999-12-31';
            return ad.localeCompare(bd) || (parseInt(b.importance) || 0) - (parseInt(a.importance) || 0);
        });
        if (!leaves.length) {
            listEl.innerHTML = '<div class="todo-empty"><div class="todo-empty-icon">&#127919;</div>' + (searchQuery ? '没有匹配的可执行任务' : '目前没有未完成的可执行任务') + '</div>';
            return;
        }
        listEl.innerHTML = '<div class="todo-focus-intro">专注视图只显示每棵任务树中可以直接执行的未完成事项，并按紧急程度排序。</div>' + leaves.map(function (todo) { return renderTaskCard(todo, 0, true); }).join('');
    }

    function dagLevel(todo, byId, memo, visiting) {
        var key = String(todo.id);
        if (memo[key] !== undefined) return memo[key];
        if (visiting[key]) return 0;
        visiting[key] = true;
        var level = 0;
        dependencyIdsOf(todo).forEach(function (dependencyId) {
            var dependency = byId[dependencyId];
            if (dependency) level = Math.max(level, dagLevel(dependency, byId, memo, visiting) + 1);
        });
        delete visiting[key];
        memo[key] = level;
        return level;
    }

    function dagStatus(todo) {
        if (todo.completed == 1) return { label: '已完成', css: 'done' };
        if (isBlocked(todo)) return { label: '等待前置', css: 'blocked' };
        return { label: '可执行', css: 'ready' };
    }

    function dagDependents(todoId, source) {
        var key = String(todoId);
        return (source || todos).filter(function (todo) {
            return dependencyIdsOf(todo).some(function (dependencyId) { return dependencyId === key; });
        });
    }

    function dagReachable(todoId, direction, source) {
        var byId = {}, seen = {}, queue = [String(todoId)];
        (source || todos).forEach(function (todo) { byId[String(todo.id)] = todo; });
        while (queue.length) {
            var current = queue.shift();
            var related = direction === 'up'
                ? dependencyIdsOf(byId[current] || {})
                : dagDependents(current, source).map(function (todo) { return String(todo.id); });
            related.forEach(function (id) {
                if (!seen[id] && id !== String(todoId)) { seen[id] = true; queue.push(id); }
            });
        }
        return seen;
    }

    function attachDagInteractions(source) {
        var wrap = document.getElementById('todo-dag-wrap');
        if (!wrap) return;
        var nodes = wrap.querySelectorAll('.todo-dag-node[data-dag-id]');
        function clearHighlight() {
            wrap.querySelectorAll('.todo-dag-node, .todo-dag-edge').forEach(function (item) {
                item.classList.remove('highlighted', 'dimmed', 'upstream', 'downstream');
            });
        }
        function highlight(todoId) {
            var id = String(todoId), upstream = dagReachable(id, 'up', source), downstream = dagReachable(id, 'down', source);
            wrap.querySelectorAll('.todo-dag-node[data-dag-id]').forEach(function (node) {
                var nodeId = node.dataset.dagId;
                if (nodeId === id) node.classList.add('highlighted');
                else if (upstream[nodeId]) node.classList.add('upstream');
                else if (downstream[nodeId]) node.classList.add('downstream');
                else node.classList.add('dimmed');
            });
            wrap.querySelectorAll('.todo-dag-edge[data-dag-from]').forEach(function (edge) {
                var from = edge.dataset.dagFrom, to = edge.dataset.dagTo;
                if ((from === id && downstream[to]) || (to === id && upstream[from]) || (upstream[from] && downstream[to])) edge.classList.add('highlighted');
                else edge.classList.add('dimmed');
            });
        }
        nodes.forEach(function (node) {
            node.addEventListener('mouseenter', function () { highlight(node.dataset.dagId); });
            node.addEventListener('mouseleave', clearHighlight);
            node.addEventListener('focus', function () { highlight(node.dataset.dagId); });
            node.addEventListener('blur', clearHighlight);
        });
    }

    function renderDag(filtered) {
        var wrap = document.getElementById('todo-dag-wrap');
        if (!wrap) return;
        var source = filtered;
        if (!source.length) {
            wrap.innerHTML = '<div class="todo-empty"><div class="todo-empty-icon">&#128279;</div>' + (searchQuery ? '没有匹配的依赖关系' : '暂无可展示的依赖关系') + '</div>';
            return;
        }

        var byId = {}, memo = {}, visiting = {}, maxLevel = 0;
        source.forEach(function (todo) { byId[String(todo.id)] = todo; });
        source.forEach(function (todo) { maxLevel = Math.max(maxLevel, dagLevel(todo, byId, memo, visiting)); });
        var levels = [];
        for (var i = 0; i <= maxLevel; i++) levels.push([]);
        source.forEach(function (todo) { levels[memo[String(todo.id)] || 0].push(todo); });
        levels.forEach(function (level) {
            level.sort(function (a, b) {
                return priorityLevel(getEffectivePriority(b)) - priorityLevel(getEffectivePriority(a)) || Number(a.id) - Number(b.id);
            });
        });

        var html = '<div class="todo-dag-header"><div><strong>任务依赖图</strong><span>箭头方向：前置任务 → 当前任务 · 悬停查看上下游</span></div><div class="todo-dag-legend"><span><i class="todo-dag-dot ready"></i>可执行</span><span><i class="todo-dag-dot blocked"></i>等待前置</span><span><i class="todo-dag-dot done"></i>已完成</span></div></div>';
        html += '<div class="todo-dag-board"><svg class="todo-dag-arrows" aria-hidden="true"></svg><div class="todo-dag-grid">';
        levels.forEach(function (level, levelIndex) {
            html += '<section class="todo-dag-level"><div class="todo-dag-level-label">' + (levelIndex === 0 ? '起点' : '第 ' + levelIndex + ' 层') + '</div>';
            level.forEach(function (todo) {
                var status = dagStatus(todo);
                var actionId = /^\d+$/.test(String(todo.id)) ? String(todo.id) : "'" + escapeAttribute(todo.id) + "'";
                var dependencies = dependenciesOf(todo);
                var dependents = dagDependents(todo.id, source);
                html += '<article class="todo-dag-node ' + status.css + '" data-dag-id="' + escapeAttribute(todo.id) + '" data-id="' + escapeAttribute(todo.id) + '" tabindex="0">';
                html += '<div class="todo-dag-node-accent ' + priorityCss(getEffectivePriority(todo)) + '"></div><div class="todo-dag-node-body">';
                html += '<div class="todo-dag-node-top"><span class="todo-dag-status ' + status.css + '">' + status.label + '</span><span class="todo-priority-tag ' + priorityCss(getEffectivePriority(todo)) + '">' + priorityLabel(getEffectivePriority(todo)) + '</span></div>';
                html += '<div class="todo-dag-node-title">' + escapeHtml(todo.title) + '</div>';
                if (todo.notes) html += '<div class="todo-dag-node-notes">' + escapeHtml(todo.notes) + '</div>';
                if (dependencies.length) {
                    html += '<div class="todo-dag-node-deps"><span>前置</span><span class="todo-dag-inline-arrow">→</span><span>' + dependencies.map(function (dependency) { return escapeHtml(dependency.title); }).join('、') + '</span></div>';
                } else {
                    html += '<div class="todo-dag-node-deps todo-dag-no-deps">无需等待前置任务</div>';
                }
                html += '<div class="todo-dag-node-relations"><span>前置 ' + dependencies.length + '</span><span>后续 ' + dependents.length + '</span></div>';
                if (isBlocked(todo)) html += '<div class="todo-dag-waiting">等待：' + escapeHtml(dependencyNames(todo).join('、')) + '</div>';
                html += '</div><button class="todo-dag-edit" type="button" onclick="window._todo.editFromDag(' + actionId + ')" title="编辑任务">&#9998;</button></article>';
            });
            html += '</section>';
        });
        html += '</div></div>';
        wrap.innerHTML = html;
        window.setTimeout(function () { drawDagArrows(); attachDagInteractions(source); }, 0);
    }

    function drawDagArrows() {
        if (currentView !== 'dag') return;
        var board = document.querySelector('.todo-dag-board');
        var svg = board && board.querySelector('.todo-dag-arrows');
        if (!board || !svg) return;
        var boardRect = board.getBoundingClientRect();
        var nodeMap = {};
        board.querySelectorAll('.todo-dag-node[data-dag-id]').forEach(function (node) { nodeMap[node.dataset.dagId] = node; });
        svg.setAttribute('width', board.scrollWidth);
        svg.setAttribute('height', board.scrollHeight);
        svg.setAttribute('viewBox', '0 0 ' + board.scrollWidth + ' ' + board.scrollHeight);
        var markup = '<defs><marker id="todo-dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#8da2bd"></path></marker></defs>';
        todos.forEach(function (todo) {
            var target = nodeMap[String(todo.id)];
            if (!target) return;
            var targetRect = target.getBoundingClientRect();
            dependencyIdsOf(todo).forEach(function (dependencyId) {
                var source = nodeMap[String(dependencyId)];
                if (!source) return;
                var sourceRect = source.getBoundingClientRect();
                var x1 = sourceRect.right - boardRect.left + board.scrollLeft;
                var y1 = sourceRect.top + sourceRect.height / 2 - boardRect.top + board.scrollTop;
                var x2 = targetRect.left - boardRect.left + board.scrollLeft;
                var y2 = targetRect.top + targetRect.height / 2 - boardRect.top + board.scrollTop;
                var bend = Math.max(28, (x2 - x1) * 0.42);
                markup += '<path class="todo-dag-edge" data-dag-from="' + escapeAttribute(dependencyId) + '" data-dag-to="' + escapeAttribute(todo.id) + '" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" marker-end="url(#todo-dag-arrow)"></path>';
            });
        });
        svg.innerHTML = markup;
    }

    /* ========== 2D Chart ========== */

    function renderChart(filtered) {
        var wrap = document.getElementById('todo-chart-wrap');
        chartCanvas = document.getElementById('todo-chart');
        if (!chartCanvas) return;
        chartCtx = chartCanvas.getContext('2d');

        var rect = wrap.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        var w = rect.width;
        var h = Math.max(400, Math.min(w * 0.65, 520));
        chartCanvas.width = w * dpr;
        chartCanvas.height = h * dpr;
        chartCanvas.style.width = w + 'px';
        chartCanvas.style.height = h + 'px';
        chartCtx.scale(dpr, dpr);

        var isDark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
        var p = chartPadding;
        var cw = w - p.left - p.right;
        var ch = h - p.top - p.bottom;

        chartCtx.clearRect(0, 0, w, h);

        // X轴分割线位置：3天 和 14天（按比例）
        var MAX_DAYS = 21; // X轴最大天数
        var XOFFSET = 3;   // 左边留给过期的
        var xTotalRange = MAX_DAYS + XOFFSET;
        var x3 = p.left + ((3.2 + XOFFSET) / xTotalRange) * cw;
        var x14 = p.left + ((14 + XOFFSET) / xTotalRange) * cw;
        var IMP_SPLIT = 3.2; // 重要/不重要分界线
        var impYRatio = (IMP_SPLIT - 1) / 4; // 在0~1范围内的位置
        var yPadC = 0.08;
        var splitY = p.top + ch * (1 - yPadC) - impYRatio * ch * (1 - 2 * yPadC);

        // 辅助函数：天数→屏幕X，重要度→屏幕Y
        function daysToX(d) { return p.left + ((d + XOFFSET) / xTotalRange) * cw; }
        function impToY(v) { return p.top + ch * (1 - yPadC) - ((v - 1) / 4) * ch * (1 - 2 * yPadC); }

        // 升星分界线：x≤14天时 y=3.2★, x>14天时 y=3+(x-14)/7*0.5
        // 这条线就是计划做和一般事务的边界
        var slopeStartX = daysToX(14);
        var slopeStartY = impToY(3.0); // 14天时boost=3
        var slopeEndDays = MAX_DAYS;
        var slopeEndImp = Math.min(5, 3 + (slopeEndDays - 14) / 7 * 0.5); // 21天时=3.5
        var slopeEndX = daysToX(slopeEndDays);
        var slopeEndY = impToY(slopeEndImp);

        var chartLeft = p.left;
        var chartRight = p.left + cw;
        var chartTop = p.top;
        var chartBottom = p.top + ch;

        // 四象限背景 — 使用path绘制多边形

        // 1. 紧急+重要 (左上) — 红：矩形
        chartCtx.fillStyle = isDark ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.25)';
        chartCtx.fillRect(chartLeft, chartTop, x3 - chartLeft, splitY - chartTop);

        // 2. 紧急+不重要 (左下) — 橙黄：矩形
        chartCtx.fillStyle = isDark ? 'rgba(234,179,8,0.30)' : 'rgba(234,179,8,0.22)';
        chartCtx.fillRect(chartLeft, splitY, x3 - chartLeft, chartBottom - splitY);

        // 3. 计划做 (右上) — 橙：梯形多边形
        //    从x3到x14: 底边是splitY (y=3.2)
        //    从x14到xEnd: 底边沿升星斜线上升
        chartCtx.fillStyle = isDark ? 'rgba(245,158,11,0.28)' : 'rgba(245,158,11,0.18)';
        chartCtx.beginPath();
        chartCtx.moveTo(x3, chartTop);           // 左上角
        chartCtx.lineTo(chartRight, chartTop);     // 右上角
        chartCtx.lineTo(chartRight, slopeEndY);    // 右边沿斜线
        chartCtx.lineTo(slopeStartX, slopeStartY); // 14天处 y=3
        chartCtx.lineTo(x3, splitY);               // 3.2天处 y=3.2
        chartCtx.closePath();
        chartCtx.fill();

        // 4. 一般事务 (右下) — 绿：梯形多边形（剩余区域）
        chartCtx.fillStyle = isDark ? 'rgba(16,185,129,0.25)' : 'rgba(16,185,129,0.16)';
        chartCtx.beginPath();
        chartCtx.moveTo(x3, splitY);               // 左边 y=3.2
        chartCtx.lineTo(slopeStartX, slopeStartY); // 14天处 y=3
        chartCtx.lineTo(chartRight, slopeEndY);     // 右边沿斜线
        chartCtx.lineTo(chartRight, chartBottom);    // 右下角
        chartCtx.lineTo(x3, chartBottom);            // 左下角
        chartCtx.closePath();
        chartCtx.fill();

        // 象限文字 — 放在各区域视觉中心
        chartCtx.font = 'bold 16px sans-serif';
        chartCtx.textAlign = 'center';

        // 左上：立即做（矩形中心）
        var luCx = (chartLeft + x3) / 2;
        var luCy = (chartTop + splitY) / 2;
        chartCtx.fillStyle = isDark ? '#f87171' : '#dc2626';
        chartCtx.fillText('紧急且重要', luCx, luCy - 8);
        chartCtx.fillText('立即做!', luCx, luCy + 12);

        // 右上：计划做（梯形，取x中点处的上下边中点）
        var planCx = (x3 + chartRight) / 2;
        // 计算planCx对应的斜线y值
        var planDays = ((planCx - p.left) / cw) * xTotalRange - XOFFSET;
        var planBottomImp = planDays > 14 ? 3 + (planDays - 14) / 7 * 0.5 : 3.2;
        var planBottomY = impToY(planBottomImp);
        var planCy = (chartTop + planBottomY) / 2;
        chartCtx.fillStyle = isDark ? '#fbbf24' : '#d97706';
        chartCtx.fillText('计划做', planCx, planCy);

        // 左下：快速做（矩形中心）
        var llCx = (chartLeft + x3) / 2;
        var llCy = (splitY + chartBottom) / 2;
        chartCtx.fillStyle = isDark ? '#facc15' : '#b45309';
        chartCtx.fillText('快速做', llCx, llCy);

        // 右下：一般事务（梯形，取x中点处的斜线和底边中点）
        var genCx = planCx;
        var genCy = (planBottomY + chartBottom) / 2;
        chartCtx.fillStyle = isDark ? '#34d399' : '#047857';
        chartCtx.fillText('一般事务', genCx, genCy);

        // 分割虚线 — x=3.2天为主竖线，y=3.2★+升星斜线为横线
        chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
        chartCtx.setLineDash([6, 4]);
        chartCtx.lineWidth = 1.5;
        chartCtx.beginPath();
        chartCtx.moveTo(x3, chartTop); chartCtx.lineTo(x3, chartBottom);
        chartCtx.stroke();
        // 水平段 splitY (x3→x14) + 斜线段 (x14→xEnd)
        chartCtx.beginPath();
        chartCtx.moveTo(x3, splitY);
        chartCtx.lineTo(slopeStartX, slopeStartY);
        chartCtx.lineTo(chartRight, slopeEndY);
        chartCtx.stroke();
        chartCtx.setLineDash([]);

        // 今天红虚线
        var xToday = p.left + ((0 + XOFFSET) / xTotalRange) * cw;
        chartCtx.strokeStyle = isDark ? 'rgba(239,68,68,0.6)' : 'rgba(220,38,38,0.5)';
        chartCtx.setLineDash([4, 3]);
        chartCtx.lineWidth = 1.5;
        chartCtx.beginPath();
        chartCtx.moveTo(xToday, p.top); chartCtx.lineTo(xToday, p.top + ch);
        chartCtx.stroke();
        chartCtx.setLineDash([]);
        // "今天"标注
        chartCtx.fillStyle = isDark ? 'rgba(239,68,68,0.8)' : 'rgba(220,38,38,0.65)';
        chartCtx.font = 'bold 13px sans-serif';
        chartCtx.textAlign = 'center';
        chartCtx.fillText('TODAY', xToday, p.top - 6);

        // 坐标轴
        var axisColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)';
        chartCtx.strokeStyle = axisColor;
        chartCtx.lineWidth = 1.5;
        chartCtx.beginPath();
        chartCtx.moveTo(p.left, p.top); chartCtx.lineTo(p.left, p.top + ch); chartCtx.lineTo(p.left + cw, p.top + ch);
        chartCtx.stroke();
        chartCtx.lineWidth = 1;

        // X轴标签
        var textColor = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)';
        chartCtx.fillStyle = textColor;
        chartCtx.font = '14px sans-serif';
        chartCtx.textAlign = 'center';

        var xTickDays = [-2, 0, 1, 2, 3, 7, 14, 21];
        var xTickLabels = ['过期', '今天', '明天', '后天', '3天', '1周', '2周', '3周'];

        // 在3天处加粗刻度标注（主分割线）
        for (var i = 0; i < xTickDays.length; i++) {
            var tx = p.left + ((xTickDays[i] + XOFFSET) / xTotalRange) * cw;
            var isSplit = (xTickDays[i] === 3);
            chartCtx.font = isSplit ? 'bold 14px sans-serif' : '14px sans-serif';
            chartCtx.fillStyle = isSplit ? (isDark ? '#f87171' : '#dc2626') : textColor;
            chartCtx.fillText(xTickLabels[i], tx, p.top + ch + 18);
            // 小刻度线
            chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
            chartCtx.beginPath(); chartCtx.moveTo(tx, p.top + ch); chartCtx.lineTo(tx, p.top + ch + 5); chartCtx.stroke();
        }
        chartCtx.fillStyle = textColor;
        chartCtx.font = 'bold 14px sans-serif';
        chartCtx.fillText('← 紧急                              不紧急 →', p.left + cw / 2, p.top + ch + 40);

        // Y轴标签
        chartCtx.font = '14px sans-serif';
        chartCtx.textAlign = 'right';
        var yLabelPad = 0.08;
        for (var j = 1; j <= 5; j++) {
            var yy = p.top + ch * (1 - yLabelPad) - (j - 1) / 4 * ch * (1 - 2 * yLabelPad);
            chartCtx.fillStyle = textColor;
            chartCtx.fillText(j + '★', p.left - 8, yy + 4);
        }
        chartCtx.save();
        chartCtx.translate(14, p.top + ch / 2);
        chartCtx.rotate(-Math.PI / 2);
        chartCtx.textAlign = 'center';
        chartCtx.font = 'bold 14px sans-serif';        chartCtx.fillStyle = textColor;
        chartCtx.fillText('重要程度', 0, 0);
        chartCtx.restore();

        // Y轴网格线
        chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
        var yGridPad = 0.08;
        for (var g = 1; g <= 5; g++) {
            var gy = p.top + ch * (1 - yGridPad) - (g - 1) / 4 * ch * (1 - 2 * yGridPad);
            chartCtx.beginPath(); chartCtx.moveTo(p.left, gy); chartCtx.lineTo(p.left + cw, gy); chartCtx.stroke();
        }

        // 计算散点
        chartPoints = [];
        filtered.forEach(function (todo) {
            var days = getDaysRemaining(todo.due_date);
            var xVal;
            if (days === null) xVal = MAX_DAYS;
            else if (days < -XOFFSET) xVal = -XOFFSET;
            else if (days > MAX_DAYS) xVal = MAX_DAYS;
            else xVal = days;

            var imp = getEffectiveImportance(todo);
            var xRatio = (xVal + XOFFSET) / xTotalRange;
            var yPad = 0.08; // 上下各留8%，避免5★顶到象限标题
            var yRatio = (imp - 1) / 4;
            var sx = p.left + xRatio * cw;
            var sy = p.top + ch * (1 - yPad) - yRatio * ch * (1 - 2 * yPad);

            chartPoints.push({ x: xVal, y: imp, screenX: sx, screenY: sy, todo: todo });
        });

        // 散开重叠的点 — 使用螺旋排列
        var minDist = 22; // 两点最小间距
        for (var i = 0; i < chartPoints.length; i++) {
            var pi = chartPoints[i];
            var angle = 0, ring = 0, step = 0;
            var maxTries = 30;
            while (step < maxTries) {
                var collides = false;
                for (var k = 0; k < i; k++) {
                    var pk = chartPoints[k];
                    var dx = pi.screenX - pk.screenX;
                    var dy = pi.screenY - pk.screenY;
                    if (Math.sqrt(dx * dx + dy * dy) < minDist) {
                        collides = true;
                        break;
                    }
                }
                if (!collides) break;
                step++;
                angle = step * 2.4; // 黄金角螺旋
                ring = minDist * 0.5 * Math.sqrt(step);
                var origX = p.left + ((pi.x + XOFFSET) / xTotalRange) * cw;
                var yPad2 = 0.08;
                var origY = p.top + ch * (1 - yPad2) - ((pi.y - 1) / 4) * ch * (1 - 2 * yPad2);
                pi.screenX = origX + Math.cos(angle) * ring;
                pi.screenY = origY + Math.sin(angle) * ring;
            }
        }

        // 画散点
        chartPoints.forEach(function (pt) {
            var completed = pt.todo.completed == 1;
            var r = completed ? 6 : 10;
            var alpha = completed ? 0.35 : 0.9;

            // 颜色根据4象限（紧急=3.2天内，重要=3.2★+含升星斜线）
            var impThreshold = pt.x > 14 ? 3 + (pt.x - 14) / 7 * 0.5 : 3.2;
            var color;
            if (pt.x <= 3.2 && pt.y >= 3.2) color = 'rgba(220,38,38,' + alpha + ')';       // 立即做 红
            else if (pt.x <= 3.2 && pt.y < 3.2) color = 'rgba(217,119,6,' + alpha + ')';    // 快速做 橙
            else if (pt.y >= impThreshold) color = 'rgba(245,158,11,' + alpha + ')';          // 计划做 金橙
            else color = 'rgba(16,185,129,' + alpha + ')';                                     // 一般事务 绿

            // 阴影
            chartCtx.shadowColor = 'rgba(0,0,0,0.15)';
            chartCtx.shadowBlur = 4;
            chartCtx.shadowOffsetY = 2;

            chartCtx.beginPath();
            chartCtx.arc(pt.screenX, pt.screenY, r, 0, Math.PI * 2);
            chartCtx.fillStyle = color;
            chartCtx.fill();

            chartCtx.shadowColor = 'transparent';

            // 边框
            chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
            chartCtx.lineWidth = 1.5;
            chartCtx.stroke();

            // 已完成划线
            if (completed) {
                chartCtx.beginPath();
                chartCtx.moveTo(pt.screenX - r, pt.screenY);
                chartCtx.lineTo(pt.screenX + r, pt.screenY);
                chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
                chartCtx.lineWidth = 2;
                chartCtx.stroke();
            }

            // Hover 高亮
            if (hoveredPoint && hoveredPoint.todo.id === pt.todo.id) {
                chartCtx.beginPath();
                chartCtx.arc(pt.screenX, pt.screenY, r + 5, 0, Math.PI * 2);
                chartCtx.strokeStyle = color;
                chartCtx.lineWidth = 2.5;
                chartCtx.stroke();
            }

            // 番茄钟专注中 — 脉冲闪烁光环
            if (isPomodoring(pt.todo.id)) {
                var pulse = (Math.sin(Date.now() / 400) + 1) / 2; // 0~1 脉冲
                var pulseR = r + 6 + pulse * 8;
                var pulseAlpha = 0.15 + pulse * 0.35;
                chartCtx.beginPath();
                chartCtx.arc(pt.screenX, pt.screenY, pulseR, 0, Math.PI * 2);
                chartCtx.strokeStyle = 'rgba(239,68,68,' + pulseAlpha + ')';
                chartCtx.lineWidth = 2.5;
                chartCtx.stroke();
                // 内层红色光晕
                chartCtx.beginPath();
                chartCtx.arc(pt.screenX, pt.screenY, r + 3, 0, Math.PI * 2);
                chartCtx.strokeStyle = 'rgba(239,68,68,' + (0.4 + pulse * 0.3) + ')';
                chartCtx.lineWidth = 2;
                chartCtx.stroke();
            }
        });

        // Tooltip
        if (hoveredPoint) drawTooltip(hoveredPoint, w, h, isDark);
    }

    function drawTooltip(pt, canvasW, canvasH, isDark) {
        var todo = pt.todo;
        var effP = hasChildren(todo) ? treePriority(todo) : getEffectivePriority(todo);
        var lines = [escapeHtmlPlain(todo.title)];
        lines.push('紧急度: ' + priorityLabel(effP));
        lines.push('重要度: ' + importanceStars(todo.importance));
        if (todo.due_date) {
            var days = getDaysRemaining(todo.due_date);
            var dueText = formatDate(todo.due_date);
            if (days < 0) dueText += ' (已过期' + Math.abs(days) + '天)';
            else if (days === 0) dueText += ' (今天)';
            else dueText += ' (剩余' + days + '天)';
            lines.push('截止: ' + dueText);
        } else {
            lines.push('截止: 未设定');
        }
        if (todo.completed == 1) lines.push('✓ 已完成');

        chartCtx.font = '12px sans-serif';
        var maxW = 0;
        lines.forEach(function (l) { var m = chartCtx.measureText(l).width; if (m > maxW) maxW = m; });
        var tw = maxW + 24;
        var th = lines.length * 22 + 16;
        var tx = pt.screenX + 16;
        var ty = pt.screenY - th / 2;
        if (tx + tw > canvasW - 10) tx = pt.screenX - tw - 16;
        if (ty < 5) ty = 5;
        if (ty + th > canvasH - 5) ty = canvasH - th - 5;

        // 背景
        chartCtx.shadowColor = 'rgba(0,0,0,0.15)';
        chartCtx.shadowBlur = 12;
        chartCtx.shadowOffsetY = 4;
        chartCtx.fillStyle = isDark ? 'rgba(30,30,30,0.97)' : 'rgba(255,255,255,0.98)';
        chartCtx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)';
        chartCtx.lineWidth = 1;
        roundRect(chartCtx, tx, ty, tw, th, 10);
        chartCtx.fill();
        chartCtx.stroke();
        chartCtx.shadowColor = 'transparent';

        // 文字
        chartCtx.fillStyle = isDark ? 'rgba(255,255,255,0.95)' : '#222';
        chartCtx.textAlign = 'left';
        chartCtx.font = 'bold 13px sans-serif';
        chartCtx.fillText(lines[0], tx + 12, ty + 22);
        chartCtx.font = '11px sans-serif';
        chartCtx.fillStyle = isDark ? 'rgba(255,255,255,0.7)' : '#555';
        for (var i = 1; i < lines.length; i++) {
            chartCtx.fillText(lines[i], tx + 12, ty + 22 + i * 22);
        }
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function findPointAt(mx, my) {
        var closest = null, minDist = 20;
        chartPoints.forEach(function (pt) {
            var dx = pt.screenX - mx, dy = pt.screenY - my;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) { minDist = dist; closest = pt; }
        });
        return closest;
    }

    function initChartEvents() {
        var canvas = document.getElementById('todo-chart');
        if (!canvas) return;
        canvas.addEventListener('mousemove', function (e) {
            var rect = canvas.getBoundingClientRect();
            var pt = findPointAt(e.clientX - rect.left, e.clientY - rect.top);
            if (pt !== hoveredPoint) {
                hoveredPoint = pt;
                canvas.style.cursor = pt ? 'pointer' : 'default';
                if (currentView === 'chart') renderChart(getFilteredTodos());
            }
        });
        canvas.addEventListener('mouseleave', function () {
            if (hoveredPoint) { hoveredPoint = null; if (currentView === 'chart') renderChart(getFilteredTodos()); }
        });
        canvas.addEventListener('click', function (e) {
            var rect = canvas.getBoundingClientRect();
            var pt = findPointAt(e.clientX - rect.left, e.clientY - rect.top);
            if (pt) { setView('list'); startEdit(pt.todo.id); }
        });
    }

    /* ========== Pomodoro 番茄钟（最多3个并行） ========== */
    var pomodoroSlots = []; // [{todoId, phase, remaining, paused, count, timer}]
    var pomodoroOrigTitle = '';
    var pomodoroAnimFrame = null;
    var FOCUS_DURATION = 25 * 60;
    var BREAK_DURATION = 5 * 60;
    var LONG_BREAK_DURATION = 15 * 60;
    var POMODORO_STORAGE = 'pomodoro_counts';
    var POMODORO_STATE = 'pomodoro_state';
    var MAX_POMODORO = 3;

    var pomodoroCounts = {}; // 番茄计数缓存
    var pomodoroMinutes = {}; // 累计专注分钟数

    function getPomodoroCount(todoId) {
        return pomodoroCounts[todoId] || 0;
    }
    function getPomodoroMinutes(todoId) {
        return pomodoroMinutes[todoId] || 0;
    }
    function addPomodoroCount(todoId) {
        pomodoroCounts[todoId] = (pomodoroCounts[todoId] || 0) + 1;
    }
    function addPomodoroMinutes(todoId, mins) {
        pomodoroMinutes[todoId] = (pomodoroMinutes[todoId] || 0) + mins;
    }
    function formatMinutes(m) {
        m = Math.round(m);
        if (m < 60) return m + '分钟';
        var h = Math.floor(m / 60);
        var r = m % 60;
        return r > 0 ? h + 'h' + r + 'm' : h + 'h';
    }

    function findSlot(todoId) {
        return pomodoroSlots.find(function (s) { return s.todoId == todoId; });
    }
    function isPomodoring(todoId) { return !!findSlot(todoId); }

    function savePomodoroState() {
        var stateData = pomodoroSlots.map(function (s) {
            return {
                todoId: s.todoId, phase: s.phase, count: s.count, paused: s.paused,
                endTime: s.paused ? null : Date.now() + s.remaining * 1000,
                remaining: s.remaining
            };
        });
        // 本地缓存
        try {
            if (pomodoroSlots.length === 0) localStorage.removeItem(POMODORO_STATE);
            else localStorage.setItem(POMODORO_STATE, JSON.stringify(stateData));
            localStorage.setItem(POMODORO_STORAGE, JSON.stringify(pomodoroCounts));
            localStorage.setItem('pomodoro_minutes', JSON.stringify(pomodoroMinutes));
        } catch (e) { }
        // 同步到服务端
        savePomodoroToServer();
    }

    var _pomodoroSaveTimer = null;
    function savePomodoroToServer() {
        // 防抖：500ms 内多次调用只发一次请求
        clearTimeout(_pomodoroSaveTimer);
        _pomodoroSaveTimer = setTimeout(function () {
            var stateData = pomodoroSlots.map(function (s) {
                return {
                    todoId: s.todoId, phase: s.phase, count: s.count, paused: s.paused,
                    endTime: s.paused ? null : Date.now() + s.remaining * 1000,
                    remaining: s.remaining
                };
            });
            ajax('pomodoro_save', {
                state: JSON.stringify(stateData),
                counts: JSON.stringify(pomodoroCounts),
                minutes: JSON.stringify(pomodoroMinutes)
            }).catch(function () { });
        }, 500);
    }

    function restorePomodoro() {
        // 优先从服务端加载，失败则用 localStorage
        ajax('pomodoro_get').then(function (data) {
            applyPomodoroData(data.state || [], data.counts || {}, data.minutes || {});
        }).catch(function () {
            // 降级到本地
            try {
                var arr = JSON.parse(localStorage.getItem(POMODORO_STATE));
                var counts = JSON.parse(localStorage.getItem(POMODORO_STORAGE) || '{}');
                var minutes = JSON.parse(localStorage.getItem('pomodoro_minutes') || '{}');
                applyPomodoroData(Array.isArray(arr) ? arr : [], counts || {}, minutes || {});
            } catch (e) { }
        });
    }

    function applyPomodoroData(arr, counts, minutes) {
        pomodoroCounts = counts || {};
        pomodoroMinutes = minutes || {};
        if (!Array.isArray(arr) || arr.length === 0) return;
        arr.forEach(function (s) {
            var todo = todos.find(function (t) { return t.id == s.todoId; });
            if (!todo) return;
            // 避免重复恢复
            if (findSlot(s.todoId)) return;
            var slot = {
                todoId: s.todoId, phase: s.phase, count: s.count || 0,
                paused: s.paused || false, remaining: 0, timer: null
            };
            if (s.paused) {
                slot.remaining = s.remaining || 0;
            } else {
                slot.remaining = Math.max(0, Math.round((s.endTime - Date.now()) / 1000));
            }
            pomodoroSlots.push(slot);
            slot.timer = setInterval(function () { tickSlot(slot); }, 1000);
            if (slot.remaining <= 0 && !slot.paused) {
                endSlotPhase(slot);
            }
        });
        if (pomodoroSlots.length > 0) {
            pomodoroOrigTitle = document.title;
            renderPomodoroUI();
            startPomodoroAnim();
        }
    }

    function startPomodoro(todoId) {
        if (findSlot(todoId)) {
            alert('这个任务已经在计时了！');
            return;
        }
        if (pomodoroSlots.length >= MAX_POMODORO) {
            alert('最多同时专注' + MAX_POMODORO + '件事情！\n完成或停止一个再开始新的吧。');
            return;
        }
        if (!pomodoroOrigTitle) pomodoroOrigTitle = document.title;
        var todo = todos.find(function (t) { return t.id == todoId; });
        var slot = {
            todoId: todoId, phase: 'focus', remaining: FOCUS_DURATION,
            paused: false, count: 0, timer: null, phaseStartedAt: Date.now()
        };
        pomodoroSlots.push(slot);
        slot.timer = setInterval(function () { tickSlot(slot); }, 1000);
        renderPomodoroUI();
        savePomodoroState();
        startPomodoroAnim();
        render();
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function tickSlot(slot) {
        if (slot.paused) return;
        slot.remaining--;
        if (slot.remaining <= 0) {
            endSlotPhase(slot);
        }
        renderPomodoroUI();
        savePomodoroState();
    }

    function endSlotPhase(slot) {
        var todo = todos.find(function (t) { return t.id == slot.todoId; });
        var name = todo ? todo.title : '';
        if (slot.phase === 'focus') {
            slot.count++;
            addPomodoroCount(slot.todoId);
            addPomodoroMinutes(slot.todoId, FOCUS_DURATION / 60);
            render();
            if (slot.count % 4 === 0) {
                slot.phase = 'longbreak';
                slot.remaining = LONG_BREAK_DURATION;
            } else {
                slot.phase = 'break';
                slot.remaining = BREAK_DURATION;
            }
            pomodoroNotify('「' + name + '」专注完成! 休息一下');
        } else {
            slot.phase = 'focus';
            slot.remaining = FOCUS_DURATION;
            pomodoroNotify('「' + name + '」休息结束! 继续专注');
        }
        renderPomodoroUI();
    }

    function pauseSlot(todoId) {
        var slot = findSlot(todoId);
        if (!slot) return;
        slot.paused = !slot.paused;
        if (slot.paused) document.title = pomodoroOrigTitle;
        renderPomodoroUI();
        savePomodoroState();
    }

    function stopSlot(todoId) {
        var idx = pomodoroSlots.findIndex(function (s) { return s.todoId == todoId; });
        if (idx === -1) return;
        var slot = pomodoroSlots[idx];
        // 如果在专注阶段，记录已经专注的分钟数
        if (slot.phase === 'focus') {
            var totalSec = FOCUS_DURATION;
            var elapsed = totalSec - slot.remaining;
            if (elapsed > 0) addPomodoroMinutes(todoId, elapsed / 60);
        }
        clearInterval(slot.timer);
        pomodoroSlots.splice(idx, 1);
        if (pomodoroSlots.length === 0) {
            stopPomodoroAnim();
            document.title = pomodoroOrigTitle || document.title;
        }
        renderPomodoroUI();
        savePomodoroState();
        render();
    }

    function renderPomodoroUI() {
        var container = document.getElementById('pomodoro-container');
        if (!container) return;
        if (pomodoroSlots.length === 0) { container.innerHTML = ''; return; }

        var html = '';
        pomodoroSlots.forEach(function (slot) {
            var todo = todos.find(function (t) { return t.id == slot.todoId; });
            var m = Math.floor(slot.remaining / 60);
            var s = slot.remaining % 60;
            var timeStr = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
            var phaseText = slot.phase === 'focus' ? '专注中' : slot.phase === 'break' ? '短休息' : '长休息';
            var isFocus = slot.phase === 'focus';
            var barClass = 'pomodoro-bar' + (slot.phase === 'longbreak' ? ' longbreak' : !isFocus ? ' break' : '') + (slot.paused ? ' paused' : '');

            html += '<div class="' + barClass + '">';
            html += '<span class="pomodoro-icon">&#127813;</span>';
            html += '<span class="pomodoro-task-name">' + escapeHtml(todo ? todo.title : '') + '</span>';
            html += '<span class="pomodoro-timer">' + timeStr + '</span>';
            html += '<span class="pomodoro-phase' + (pomodoroSlots.length > 1 ? ' hide-when-crowded' : '') + '">' + phaseText + '</span>';
            html += '<div class="pomodoro-actions">';
            html += '<button class="pomodoro-btn" onclick="window._todo.pauseSlot(' + slot.todoId + ')" title="' + (slot.paused ? '继续' : '暂停') + '">' + (slot.paused ? '&#9654;' : '&#9208;') + '</button>';
            html += '<button class="pomodoro-btn" onclick="window._todo.stopSlot(' + slot.todoId + ')" title="停止">&#9209;</button>';
            html += '</div>';
            var countStr = '';
            for (var i = 0; i < slot.count; i++) countStr += '&#127813;';
            if (countStr) html += '<span class="pomodoro-count">' + countStr + '</span>';
            html += '</div>';
        });
        container.innerHTML = html;

        // 标题栏显示第一个运行中的计时
        var active = pomodoroSlots.find(function (s) { return !s.paused; });
        if (active) {
            var am = Math.floor(active.remaining / 60);
            var as = active.remaining % 60;
            var at = (am < 10 ? '0' : '') + am + ':' + (as < 10 ? '0' : '') + as;
            var ap = active.phase === 'focus' ? '专注中' : '休息中';
            document.title = at + ' ' + ap + ' - 待办事项';
        } else {
            document.title = pomodoroOrigTitle || '待办事项';
        }
    }

    function pomodoroNotify(msg) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('番茄钟', { body: msg });
        }
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = 880; osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
        } catch (e) { }
    }

    function pomodoroCountHtml(todoId) {
        var c = getPomodoroCount(todoId);
        var m = getPomodoroMinutes(todoId);
        if (c === 0 && m === 0) return '';
        var parts = [];
        if (c > 0) parts.push('&#127813;' + (c > 1 ? '&times;' + c : ''));
        if (m > 0) parts.push(formatMinutes(m));
        return '<span class="todo-pomodoro-count">' + parts.join(' &middot; ') + '</span>';
    }

    function startPomodoroAnim() {
        stopPomodoroAnim();
        function frame() {
            if (currentView === 'chart' && pomodoroSlots.length > 0) {
                renderChart(getFilteredTodos());
            }
            pomodoroAnimFrame = requestAnimationFrame(frame);
        }
        pomodoroAnimFrame = requestAnimationFrame(frame);
    }
    function stopPomodoroAnim() {
        if (pomodoroAnimFrame) { cancelAnimationFrame(pomodoroAnimFrame); pomodoroAnimFrame = null; }
    }

    function initPomodoroEvents() {
        // 事件通过 onclick 直接绑定到动态渲染的按钮上
    }

    function initSearchControl() {
        var filters = document.querySelector('.todo-filters');
        if (!filters || document.getElementById('todo-search')) return;
        var label = document.createElement('label');
        label.className = 'todo-search-control';
        label.setAttribute('for', 'todo-search');
        label.innerHTML = '<span>搜索</span><input id="todo-search" type="search" placeholder="搜索标题、备注或项目路径" autocomplete="off">';
        filters.parentNode.insertBefore(label, filters);
        var input = document.getElementById('todo-search');
        input.value = searchQuery;
        input.addEventListener('input', function () {
            searchQuery = this.value.trim();
            savePreference(SEARCH_KEY, searchQuery);
            render();
        });
    }

    /* ========== Helpers ========== */
    function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str == null ? '' : String(str); return d.innerHTML; }
    function escapeAttribute(str) { return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function escapeHtmlPlain(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    /* ========== Init ========== */
    function init() {
        todos = loadFromLocal();
        // 默认矩阵视图，应用宽屏模式
        var mainMain = document.querySelector('.main-main');
        if (mainMain) mainMain.classList.add('todo-wide-mode');
        initSearchControl();
        setView(currentView);
        syncFromServer(false).catch(function () { });

        document.getElementById('todo-add-btn').addEventListener('click', addTodo);
        document.getElementById('todo-input').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTodo(); } });
        document.getElementById('todo-parent').addEventListener('change', function () { pendingParentId = this.value || ''; });
        document.getElementById('todo-dependencies').addEventListener('change', function () { pendingDependencies = Array.from(this.selectedOptions).map(function (option) { return option.value; }); });
        document.querySelectorAll('.todo-filter-btn').forEach(function (b) { b.addEventListener('click', function () { setFilter(this.dataset.filter); }); });
        document.querySelectorAll('.todo-view-btn').forEach(function (b) { b.addEventListener('click', function () { setView(this.dataset.view); }); });

        initChartEvents();
        initPomodoroEvents();
        restorePomodoro();
        var resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () { if (currentView === 'chart' || currentView === 'dag') render(); }, 200);
        });

        var impSlider = document.getElementById('todo-importance');
        var impLabel = document.getElementById('todo-importance-label');
        if (impSlider && impLabel) {
            impSlider.addEventListener('input', function () { impLabel.textContent = importanceStars(this.value); });
        }
    }

    window._todo = { toggle: toggleTodo, archive: archiveTodo, restore: restoreTodo, deleteTodo: deleteTodo, startEdit: startEdit, editFromDag: editFromDag, saveEdit: saveEdit, cancelEdit: cancelEdit, addChild: addChild, collapse: toggleCollapse, indent: indentTodo, outdent: outdentTodo, startPomodoro: startPomodoro, pauseSlot: pauseSlot, stopSlot: stopSlot };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
