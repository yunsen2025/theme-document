<?php
/**
 * 待办事项页面模板
 * Template Name: 待办事项
 * @author Haibin
 * @date 2026-04-17
 */

/* 仅管理员可访问 */
if ( ! current_user_can( 'administrator' ) ) {
	global $wp_query;
	$wp_query->set_404();
	status_header( 404 );
	get_template_part( 404 );
	exit;
}

get_header();
?>

<main class="main-container no-sidebar">
    <div class="main-main">
        <article class="main-content">
            <div class="todo-container">

                <!-- 标题区 -->
                <div class="todo-header">
                    <h2>&#128203; 待办事项</h2>
                    <p>管理你的任务，保持高效</p>
                </div>

                <!-- 添加区域 -->
                <div class="todo-add">
                    <label class="todo-add-field todo-add-field-title" for="todo-input">
                        <span class="todo-add-label">快速添加任务</span>
                        <input type="text" id="todo-input" class="todo-add-input" placeholder="想完成什么？" autocomplete="off">
                    </label>
                    <details class="todo-add-advanced">
                        <summary><span>更多设置</span><small>截止日期、优先级、任务关系与备注</small></summary>
                        <div class="todo-add-settings">
                            <label class="todo-add-field" for="todo-priority">
                                <span>处理时间</span>
                                <select id="todo-priority" class="todo-add-select">
                                    <option value="thisweek">这周处理</option>
                                    <option value="urgent">紧急</option>
                                    <option value="twodays">这两天</option>
                                    <option value="anytime">随时可以</option>
                                </select>
                            </label>
                            <label class="todo-add-field" for="todo-date">
                                <span>截止日期</span>
                                <input type="date" id="todo-date" class="todo-add-date">
                            </label>
                            <div class="todo-add-field todo-add-importance">
                                <span>重要程度</span>
                                <div class="todo-importance-control">
                                    <input type="range" id="todo-importance" min="1" max="5" value="3">
                                    <span class="importance-label" id="todo-importance-label">★★★☆☆</span>
                                </div>
                            </div>
                            <label class="todo-add-field" for="todo-parent">
                                <span>归属任务</span>
                                <select id="todo-parent" class="todo-add-select" title="第一条任务请保留为顶层任务">
                                    <option value="">顶层任务</option>
                                </select>
                            </label>
                            <label class="todo-add-field todo-add-dependencies-field" for="todo-dependencies">
                                <span>前置任务（可多选）</span>
                                <div class="todo-task-picker" data-picker-for="todo-dependencies">
                                    <div class="todo-task-picker-toolbar">
                                        <span class="todo-task-picker-hint">点击任务卡片选择前置任务</span>
                                        <span id="todo-dependencies-count" class="todo-task-picker-count">未选择</span>
                                    </div>
                                    <input id="todo-dependencies-search" class="todo-task-picker-search" type="search" placeholder="搜索任务名称或编号" autocomplete="off">
                                    <div id="todo-dependencies-selected" class="todo-task-picker-selected" aria-live="polite"></div>
                                    <div id="todo-dependencies-options" class="todo-task-picker-options" role="listbox" aria-label="前置任务选项" aria-multiselectable="true"></div>
                                    <select id="todo-dependencies" class="todo-add-select todo-dependencies-select" title="先添加其他任务后再选择前置任务" multiple size="2" tabindex="-1" aria-hidden="true"></select>
                                </div>
                            </label>
                            <label class="todo-add-field todo-add-notes" for="todo-notes">
                                <span>备注</span>
                                <textarea id="todo-notes" class="todo-add-textarea" rows="2" placeholder="补充背景、下一步或想法（可选）"></textarea>
                            </label>
                        </div>
                        <button id="todo-reset-settings" class="todo-settings-reset" type="button">重置设置</button>
                    </details>
                    <button id="todo-add-btn" class="todo-add-btn"><span aria-hidden="true">+</span> 添加</button>
                </div>

                <!-- 番茄钟计时条容器（最多3个并行，一行展示） -->
                <div id="pomodoro-container" class="pomodoro-container"></div>

                <!-- 进度条 -->
                <div class="todo-progress">
                    <div class="todo-progress-bar" id="todo-progress-bar" style="width: 0%"></div>
                </div>

                <!-- 工具栏：视图切换 + 筛选 + 统计 -->
                <div class="todo-toolbar">
                    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
                        <div class="todo-views">
                            <button class="todo-view-btn" data-view="list">&#128196; 列表</button>
                            <button class="todo-view-btn" data-view="focus">&#127919; 专注</button>
                            <button class="todo-view-btn" data-view="dag">&#128279; 依赖图</button>
                            <button class="todo-view-btn active" data-view="chart">&#128200; 矩阵</button>
                        </div>
                        <div class="todo-filters">
                            <button class="todo-filter-btn active" data-filter="all">全部</button>
                            <button class="todo-filter-btn" data-filter="active">未完成</button>
                            <button class="todo-filter-btn" data-filter="completed">已完成</button>
                            <button class="todo-filter-btn" data-filter="archived">已归档</button>
                        </div>
                    </div>
                    <div id="todo-stats" class="todo-stats"></div>
                </div>

                <!-- 列表视图 -->
                <div id="todo-list" class="todo-list" style="display:none;">
                    <div class="todo-loading">加载中...</div>
                </div>

                <!-- DAG 依赖视图 -->
                <div id="todo-dag-wrap" class="todo-dag-wrap" style="display:none;"></div>

                <!-- 2D矩阵视图 + 侧边栏 -->
                <div id="todo-matrix-wrap" class="todo-matrix-wrap">
                    <div id="todo-chart-wrap" class="todo-chart-wrap">
                        <canvas id="todo-chart"></canvas>
                    </div>
                    <div id="todo-sidebar" class="todo-sidebar"></div>
                </div>
            </div>
        </article>
    </div>
</main>

<?php get_footer(); ?>
