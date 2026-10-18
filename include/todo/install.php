<?php
/**
 * 待办事项 - 数据库表创建
 * @author Haibin
 * @date 2026-04-17
 */

function document_todo_create_table() {
	global $wpdb;
	$table_name      = $wpdb->prefix . 'document_todos';
	$charset_collate = $wpdb->get_charset_collate();

	$sql = "CREATE TABLE $table_name (
		id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
		title varchar(500) NOT NULL DEFAULT '',
		notes text DEFAULT NULL,
		parent_id bigint(20) unsigned DEFAULT NULL,
		completed tinyint(1) NOT NULL DEFAULT 0,
		archived tinyint(1) NOT NULL DEFAULT 0,
		archived_at datetime DEFAULT NULL,
		priority varchar(10) NOT NULL DEFAULT 'medium',
		importance tinyint(1) NOT NULL DEFAULT 3,
		due_date date DEFAULT NULL,
		sort_order int(11) NOT NULL DEFAULT 0,
		created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_completed (completed),
		KEY idx_parent_id (parent_id),
		KEY idx_archived (archived),
		KEY idx_priority (priority),
		KEY idx_importance (importance),
		KEY idx_sort_order (sort_order)
	) $charset_collate;";

	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	dbDelta( $sql );
}

function document_todo_install_table_exists( $table_name ) {
	global $wpdb;
	return $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table_name ) ) === $table_name;
}

/* 主题激活时创建表 */
add_action( 'after_switch_theme', 'document_todo_create_table' );

/* 子任务依赖关系：task_id 依赖 depends_on_id，允许多前置任务但禁止形成环。 */
function document_todo_create_dependencies_table() {
	global $wpdb;
	$table_name      = $wpdb->prefix . 'document_todo_edges';
	$charset_collate = $wpdb->get_charset_collate();

	$sql = "CREATE TABLE $table_name (
		task_id bigint(20) unsigned NOT NULL,
		depends_on_id bigint(20) unsigned NOT NULL,
		created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (task_id, depends_on_id),
		KEY idx_task_id (task_id),
		KEY idx_depends_on_id (depends_on_id)
	) $charset_collate;";

	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	dbDelta( $sql );
}
add_action( 'after_switch_theme', 'document_todo_create_dependencies_table' );

/* 如果表不存在则自动创建 */
function document_todo_maybe_create_table() {
	global $wpdb;
	$table_name = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table_name ) ) {
		document_todo_create_table();
	}
}
add_action( 'init', 'document_todo_maybe_create_table' );

function document_todo_maybe_create_dependencies_table() {
	global $wpdb;
	$table_name = $wpdb->prefix . 'document_todo_edges';
	if ( ! document_todo_install_table_exists( $table_name ) ) {
		document_todo_create_dependencies_table();
	}
}
add_action( 'init', 'document_todo_maybe_create_dependencies_table', 20 );

/* 升级：为已有表添加 importance 字段 */
function document_todo_maybe_add_importance() {
	global $wpdb;
	$table_name = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table_name ) ) {
		return;
	}
	$column = $wpdb->get_results( "SHOW COLUMNS FROM $table_name LIKE 'importance'" );
	if ( empty( $column ) ) {
		if ( false === $wpdb->query( "ALTER TABLE $table_name ADD COLUMN importance tinyint(1) NOT NULL DEFAULT 3 AFTER priority" ) ) {
			return;
		}
		$wpdb->query( "ALTER TABLE $table_name ADD KEY idx_importance (importance)" );
	}
}
add_action( 'init', 'document_todo_maybe_add_importance' );

/* 升级：为已有表添加归档字段 */
function document_todo_maybe_add_archive() {
	global $wpdb;
	$table_name = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table_name ) ) {
		return;
	}
	$column     = $wpdb->get_results( "SHOW COLUMNS FROM $table_name LIKE 'archived'" );

	if ( empty( $column ) ) {
		if ( false === $wpdb->query( "ALTER TABLE $table_name ADD COLUMN archived tinyint(1) NOT NULL DEFAULT 0 AFTER completed" ) ) {
			return;
		}
		if ( false === $wpdb->query( "ALTER TABLE $table_name ADD COLUMN archived_at datetime DEFAULT NULL AFTER archived" ) ) {
			return;
		}
		$wpdb->query( "ALTER TABLE $table_name ADD KEY idx_archived (archived)" );
	}
}
add_action( 'init', 'document_todo_maybe_add_archive' );

/* 升级：为已有表添加树结构和备注字段 */
function document_todo_maybe_add_hierarchy() {
	global $wpdb;
	$table_name = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table_name ) ) {
		return;
	}

	$notes_column = $wpdb->get_results( "SHOW COLUMNS FROM $table_name LIKE 'notes'" );
	if ( empty( $notes_column ) ) {
		if ( false === $wpdb->query( "ALTER TABLE $table_name ADD COLUMN notes text DEFAULT NULL AFTER title" ) ) {
			return;
		}
	}

	$parent_column = $wpdb->get_results( "SHOW COLUMNS FROM $table_name LIKE 'parent_id'" );
	if ( empty( $parent_column ) ) {
		if ( false === $wpdb->query( "ALTER TABLE $table_name ADD COLUMN parent_id bigint(20) unsigned DEFAULT NULL AFTER notes" ) ) {
			return;
		}
	}

	$parent_index = $wpdb->get_results( "SHOW INDEX FROM $table_name WHERE Key_name = 'idx_parent_id'" );
	if ( empty( $parent_index ) ) {
		$wpdb->query( "ALTER TABLE $table_name ADD KEY idx_parent_id (parent_id)" );
	}
}
add_action( 'init', 'document_todo_maybe_add_hierarchy' );

/* 升级：修复旧数据中的失效父级和父级循环，保留正常的任务层级。 */
function document_todo_normalize_hierarchy() {
	if ( get_option( 'document_todo_hierarchy_normalized_v1' ) ) {
		return;
	}

	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table ) ) {
		return;
	}

	$rows = $wpdb->get_results( "SELECT id, parent_id FROM $table", ARRAY_A );
	if ( null === $rows && $wpdb->last_error ) {
		return;
	}

	$ids     = [];
	$parents = [];
	foreach ( $rows as $row ) {
		$id            = (int) $row['id'];
		$ids[ $id ]    = true;
		$parents[ $id ] = (int) $row['parent_id'];
	}

	foreach ( array_keys( $parents ) as $id ) {
		$cursor = $id;
		$seen   = [];
		for ( $step = 0; $step <= count( $parents ); $step++ ) {
			$parent = $parents[ $cursor ] ?? 0;
			if ( ! $parent ) {
				break;
			}
			if ( ! isset( $ids[ $parent ] ) || $parent === $cursor || isset( $seen[ $parent ] ) ) {
				if ( false === $wpdb->query( $wpdb->prepare( "UPDATE $table SET parent_id = NULL WHERE id = %d", $cursor ) ) ) {
					return;
				}
				$parents[ $cursor ] = 0;
				break;
			}
			$seen[ $cursor ] = true;
			$cursor          = $parent;
		}
	}

	update_option( 'document_todo_hierarchy_normalized_v1', 1, false );
}
add_action( 'init', 'document_todo_normalize_hierarchy', 21 );

/* 升级：清理旧版本可能留下的悬空、自依赖和循环依赖边。 */
function document_todo_normalize_dependencies() {
	if ( get_option( 'document_todo_dependencies_normalized_v1' ) ) {
		return;
	}

	global $wpdb;
	$task_table = $wpdb->prefix . 'document_todos';
	$edge_table = $wpdb->prefix . 'document_todo_edges';
	if ( ! document_todo_install_table_exists( $task_table ) || ! document_todo_install_table_exists( $edge_table ) ) {
		return;
	}

	$task_ids = $wpdb->get_col( "SELECT id FROM $task_table" );
	$edges    = $wpdb->get_results( "SELECT task_id, depends_on_id FROM $edge_table ORDER BY created_at ASC, task_id ASC, depends_on_id ASC", ARRAY_A );
	if ( ( null === $task_ids || null === $edges ) && $wpdb->last_error ) {
		return;
	}
	$task_ids = array_fill_keys( array_map( 'strval', $task_ids ?: [] ), true );
	$graph    = [];

	foreach ( $edges ?: [] as $edge ) {
		$task_id = (string) absint( $edge['task_id'] );
		$dep_id  = (string) absint( $edge['depends_on_id'] );
		$invalid = ! isset( $task_ids[ $task_id ] ) || ! isset( $task_ids[ $dep_id ] ) || $task_id === $dep_id;
		$cycle  = false;
		if ( ! $invalid ) {
			// The candidate edge is task_id -> dep_id. It is cyclic only if
			// dep_id already reaches task_id through accepted edges.
			$stack = [ $dep_id ];
			$seen  = [];
			while ( $stack ) {
				$current = array_pop( $stack );
				if ( $current === $task_id ) {
					$cycle = true;
					break;
				}
				if ( isset( $seen[ $current ] ) ) {
					continue;
				}
				$seen[ $current ] = true;
				foreach ( $graph[ $current ] ?? [] as $next ) {
					$stack[] = $next;
				}
			}
		}
		if ( $invalid || $cycle ) {
			if ( false === $wpdb->delete( $edge_table, [ 'task_id' => (int) $task_id, 'depends_on_id' => (int) $dep_id ], [ '%d', '%d' ] ) ) {
				return;
			}
			continue;
		}
		$graph[ $task_id ][] = $dep_id;
	}

	update_option( 'document_todo_dependencies_normalized_v1', 1, false );
}
add_action( 'init', 'document_todo_normalize_dependencies', 22 );

/** 已完成且截止日期过去至少七天的事项自动归档；手动恢复的事项除外。 */
function document_todo_auto_archive() {
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';
	if ( ! document_todo_install_table_exists( $table ) ) {
		return 0;
	}
	$cutoff = current_datetime()->modify( '-7 days' )->format( 'Y-m-d' );
	return $wpdb->query( $wpdb->prepare(
		"UPDATE $table SET archived = 1, archived_at = %s
		 WHERE completed = 1 AND archived = 0 AND archived_at IS NULL
		 AND due_date IS NOT NULL AND due_date <> '0000-00-00' AND due_date <= %s",
		current_time( 'mysql' ),
		$cutoff
	) );
}
add_action( 'document_todo_daily_archive', 'document_todo_auto_archive' );

function document_todo_schedule_archive() {
	if ( ! wp_next_scheduled( 'document_todo_daily_archive' ) ) {
		wp_schedule_event( time(), 'daily', 'document_todo_daily_archive' );
	}
}
add_action( 'init', 'document_todo_schedule_archive', 20 );

function document_todo_unschedule_archive() {
	wp_clear_scheduled_hook( 'document_todo_daily_archive' );
}
add_action( 'switch_theme', 'document_todo_unschedule_archive' );
