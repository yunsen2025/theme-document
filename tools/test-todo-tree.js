const assert = require('node:assert/strict');
const tree = require('../common/todo/todo-tree.js');

const tasks = [
    { id: 1, title: 'Project', parent_id: null, sort_order: 0 },
    { id: 2, title: 'Prepare', parent_id: 1, sort_order: 0 },
    { id: 3, title: 'Run', parent_id: 2, sort_order: 0 },
    { id: 4, title: 'Independent', parent_id: null, sort_order: 1 },
    { id: 5, title: 'Orphan', parent_id: 999, sort_order: 2 },
    { id: 6, title: 'Cycle A', parent_id: 7, sort_order: 3 },
    { id: 7, title: 'Cycle B', parent_id: 6, sort_order: 0 }
];

assert.deepEqual(tree.childrenOf('', tasks).map((task) => task.id), [1, 4]);
assert.deepEqual(tree.childrenOf(1, tasks).map((task) => task.id), [2]);
assert.deepEqual(tree.descendantTasks(1, tasks).map((task) => task.id), [2, 3]);
assert.deepEqual(tree.descendantLeaves(1, tasks).map((task) => task.id), [3]);
assert.equal(tree.breadcrumb(tasks[2], tasks), 'Project / Prepare');

const rows = tree.treeRows(tasks, false, {});
assert.equal(rows.length, tasks.length);
assert.deepEqual(rows.slice(0, 4).map((row) => [row.todo.id, row.depth]), [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 0]
]);

console.log('todo-tree tests passed');
