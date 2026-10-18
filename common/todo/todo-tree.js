/*
 * Pure task hierarchy helpers.
 *
 * This module deliberately knows nothing about the DOM, WordPress, or the
 * current page state. The browser build exposes the helpers on
 * window.DocumentTodoTree; Node can require the same file for tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DocumentTodoTree = factory();
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function sameId(a, b) {
        return String(a) === String(b);
    }

    function parentIdOf(todo) {
        return todo && todo.parent_id ? String(todo.parent_id) : '';
    }

    function dependencyIdsOf(todo) {
        return Array.isArray(todo && todo.dependencies) ? todo.dependencies.map(String) : [];
    }

    function sortTasks(a, b) {
        var order = (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0);
        return order || String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id);
    }

    function childrenOf(parentId, source) {
        var key = parentId ? String(parentId) : '';
        return (source || []).filter(function (todo) {
            return parentIdOf(todo) === key;
        }).sort(sortTasks);
    }

    function treeRows(source, respectCollapsed, collapsed) {
        var rows = [], used = {};
        source = source || [];
        collapsed = collapsed || {};

        function visit(parentId, depth) {
            childrenOf(parentId, source).forEach(function (todo) {
                var key = String(todo.id);
                if (used[key]) return;
                used[key] = true;
                rows.push({ todo: todo, depth: depth });
                if (!respectCollapsed || !collapsed[key]) visit(key, depth + 1);
            });
        }

        visit('', 0);
        source.forEach(function (todo) {
            var key = String(todo.id);
            if (used[key]) return;
            used[key] = true;
            rows.push({ todo: todo, depth: 0 });
            if (!respectCollapsed || !collapsed[key]) visit(key, 1);
        });
        return rows;
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

    function breadcrumb(todo, source) {
        var parts = [], current = todo, seen = {};
        while (current && !seen[String(current.id)]) {
            seen[String(current.id)] = true;
            parts.unshift(current.title);
            current = (source || []).find(function (item) {
                return sameId(item.id, current.parent_id);
            });
        }
        parts.pop();
        return parts.length ? parts.join(' / ') : '';
    }

    return {
        sameId: sameId,
        parentIdOf: parentIdOf,
        dependencyIdsOf: dependencyIdsOf,
        childrenOf: childrenOf,
        treeRows: treeRows,
        descendantTasks: descendantTasks,
        descendantLeaves: descendantLeaves,
        breadcrumb: breadcrumb
    };
}));
