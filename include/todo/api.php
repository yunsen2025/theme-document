<?php
/**
 * 待办事项 - AJAX 接口
 * @author Haibin
 * @date 2026-04-17
 */

/**
 * 权限校验
 */
function document_todo_check_permission() {
	if ( ! current_user_can( 'administrator' ) ) {
		wp_send_json_error( '无权限', 403 );
	}
	check_ajax_referer( 'document_nonce', 'nonce' );
}

function document_todo_allowed_priorities() {
	return [ 'urgent', 'twodays', 'thisweek', 'anytime', 'high', 'medium', 'low' ];
}

/** 确认 parent_id 不会把任务挂到自己或自己的后代下面。 */
function document_todo_valid_parent( $id, $parent_id ) {
	if ( ! $parent_id ) {
		return true;
	}
	if ( (int) $id === (int) $parent_id ) {
		return false;
	}

	global $wpdb;
	$table  = $wpdb->prefix . 'document_todos';
	$cursor = (int) $parent_id;
	for ( $i = 0; $i < 100 && $cursor; $i++ ) {
		if ( $cursor === (int) $id ) {
			return false;
		}
		$cursor = (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT parent_id FROM $table WHERE id = %d",
			$cursor
		) );
	}

	return true;
}

function document_todo_next_sort_order( $parent_id ) {
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';
	if ( $parent_id ) {
		return (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT COALESCE(MIN(sort_order), 0) - 1 FROM $table WHERE parent_id = %d",
			$parent_id
		) );
	}

	return (int) $wpdb->get_var( "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM $table WHERE parent_id IS NULL" );
}

function document_todo_dependencies_table() {
	global $wpdb;
	return $wpdb->prefix . 'document_todo_edges';
}

function document_todo_decode_dependencies( $raw ) {
	$decoded = is_array( $raw ) ? $raw : json_decode( stripslashes( (string) $raw ), true );
	if ( ! is_array( $decoded ) ) {
		return [];
	}

	$ids = [];
	foreach ( $decoded as $value ) {
		$id = absint( $value );
		if ( $id ) {
			$ids[ $id ] = $id;
		}
	}
	return array_values( $ids );
}

/** 返回依赖关系，并拒绝自依赖、悬空任务和环。 */
function document_todo_valid_dependencies( $task_id, $dependency_ids ) {
	global $wpdb;
	$table      = $wpdb->prefix . 'document_todos';
	$edge_table = document_todo_dependencies_table();
	$dependency_ids = array_values( array_unique( array_map( 'absint', $dependency_ids ) ) );

	if ( in_array( (int) $task_id, $dependency_ids, true ) ) {
		return false;
	}
	foreach ( $dependency_ids as $dependency_id ) {
		if ( ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $dependency_id ) ) ) {
			return false;
		}
	}

	$edges = $wpdb->get_results( "SELECT task_id, depends_on_id FROM $edge_table", ARRAY_A );
	$graph = [];
	foreach ( $edges as $edge ) {
		$graph[ (string) $edge['task_id'] ][] = (string) $edge['depends_on_id'];
	}
	foreach ( $dependency_ids as $dependency_id ) {
		$stack = [ (string) $dependency_id ];
		$seen  = [];
		while ( $stack ) {
			$current = array_pop( $stack );
			if ( (string) $task_id === $current ) {
				return false;
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

	return $dependency_ids;
}

function document_todo_save_dependencies( $task_id, $dependency_ids ) {
	global $wpdb;
	$edge_table = document_todo_dependencies_table();
	$wpdb->delete( $edge_table, [ 'task_id' => (int) $task_id ], [ '%d' ] );
	foreach ( $dependency_ids as $dependency_id ) {
		$wpdb->insert(
			$edge_table,
			[ 'task_id' => (int) $task_id, 'depends_on_id' => (int) $dependency_id ],
			[ '%d', '%d' ]
		);
	}
}

function document_todo_attach_dependencies( &$rows ) {
	global $wpdb;
	$edge_table = document_todo_dependencies_table();
	$edges = $wpdb->get_results( "SELECT task_id, depends_on_id FROM $edge_table", ARRAY_A );
	$dependencies = [];
	foreach ( $edges as $edge ) {
		$dependencies[ (string) $edge['task_id'] ][] = (int) $edge['depends_on_id'];
	}
	foreach ( $rows as &$row ) {
		$row['dependencies'] = $dependencies[ (string) $row['id'] ] ?? [];
	}
	unset( $row );
}

/**
 * 获取待办列表
 */
function document_todo_list() {
	document_todo_check_permission();
	document_todo_auto_archive();
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';

	$rows = $wpdb->get_results(
		"SELECT * FROM $table ORDER BY sort_order ASC, created_at DESC",
		ARRAY_A
	);
	document_todo_attach_dependencies( $rows );

	wp_send_json_success( $rows ?: [] );
}
add_action( 'wp_ajax_todo_list', 'document_todo_list' );

/**
 * 创建待办
 */
function document_todo_create() {
	document_todo_check_permission();
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';

	$title    = sanitize_text_field( $_POST['title'] ?? '' );
	$priority = sanitize_text_field( $_POST['priority'] ?? 'medium' );
	$due_date = sanitize_text_field( $_POST['due_date'] ?? '' );
	$importance = intval( $_POST['importance'] ?? 3 );
	$notes    = sanitize_textarea_field( $_POST['notes'] ?? '' );
	$parent_id = absint( $_POST['parent_id'] ?? 0 );
	$dependencies = document_todo_decode_dependencies( $_POST['dependencies'] ?? [] );

	if ( empty( $title ) ) {
		wp_send_json_error( '标题不能为空' );
	}

	if ( ! in_array( $priority, document_todo_allowed_priorities(), true ) ) {
		$priority = 'thisweek';
	}
	if ( $parent_id && ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $parent_id ) ) ) {
		$parent_id = 0;
	}

	$importance = max( 1, min( 5, $importance ) );

	$data = [
		'title'      => $title,
		'notes'      => $notes ?: null,
		'parent_id'  => $parent_id ?: null,
		'priority'   => $priority,
		'importance' => $importance,
		'due_date'   => $due_date ?: null,
		'sort_order' => document_todo_next_sort_order( $parent_id ),
	];
	$format = [ '%s', '%s', '%d', '%s', '%d', '%s', '%d' ];

	$wpdb->insert( $table, $data, $format );
	$id = $wpdb->insert_id;
	$valid_dependencies = document_todo_valid_dependencies( $id, $dependencies );
	if ( false === $valid_dependencies ) {
		$wpdb->delete( $table, [ 'id' => $id ], [ '%d' ] );
		wp_send_json_error( '依赖关系会形成循环或包含不存在的任务' );
	}
	document_todo_save_dependencies( $id, $valid_dependencies );

	$row = $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM $table WHERE id = %d", $id ),
		ARRAY_A
	);
	$rows = [ $row ];
	document_todo_attach_dependencies( $rows );
	$row = $rows[0];

	wp_send_json_success( $row );
}
add_action( 'wp_ajax_todo_create', 'document_todo_create' );

/**
 * 更新待办
 */
function document_todo_update() {
	document_todo_check_permission();
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';

	$id = intval( $_POST['id'] ?? 0 );
	if ( ! $id ) {
		wp_send_json_error( 'ID无效' );
	}

	$update = [];
	$format = [];
	$dependencies_changed = isset( $_POST['dependencies'] );
	$dependencies = $dependencies_changed ? document_todo_decode_dependencies( $_POST['dependencies'] ) : [];

	if ( isset( $_POST['title'] ) ) {
		$update['title'] = sanitize_text_field( $_POST['title'] );
		$format[]        = '%s';
	}
	if ( isset( $_POST['notes'] ) ) {
		$update['notes'] = sanitize_textarea_field( $_POST['notes'] );
		$format[]        = '%s';
	}
	if ( isset( $_POST['completed'] ) ) {
		$update['completed'] = intval( $_POST['completed'] ) ? 1 : 0;
		$format[]            = '%d';
	}
	if ( isset( $_POST['archived'] ) ) {
		$archived = intval( $_POST['archived'] ) ? 1 : 0;
		$update['archived']    = $archived;
		$format[]              = '%d';
		// 保留上次归档时间，手动恢复的事项不再自动归档。
		if ( $archived ) {
			$update['archived_at'] = current_time( 'mysql' );
			$format[] = '%s';
		}
	}
	if ( isset( $_POST['priority'] ) ) {
		$p = sanitize_text_field( $_POST['priority'] );
		if ( in_array( $p, document_todo_allowed_priorities(), true ) ) {
			$update['priority'] = $p;
			$format[]           = '%s';
		}
	}
	if ( isset( $_POST['parent_id'] ) ) {
		$parent_id = absint( $_POST['parent_id'] );
		if ( $parent_id && ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $parent_id ) ) ) {
			wp_send_json_error( '父任务不存在' );
		}
		if ( ! document_todo_valid_parent( $id, $parent_id ) ) {
			wp_send_json_error( '不能把任务移动到自己的子任务下面' );
		}
		$update['parent_id'] = $parent_id ?: null;
		$format[]            = '%d';
	}
	if ( isset( $_POST['due_date'] ) ) {
		$update['due_date'] = sanitize_text_field( $_POST['due_date'] ) ?: null;
		$format[]           = '%s';
	}
	if ( isset( $_POST['importance'] ) ) {
		$update['importance'] = max( 1, min( 5, intval( $_POST['importance'] ) ) );
		$format[]             = '%d';
	}

	if ( empty( $update ) && ! $dependencies_changed ) {
		wp_send_json_error( '没有要更新的字段' );
	}
	if ( $dependencies_changed ) {
		$valid_dependencies = document_todo_valid_dependencies( $id, $dependencies );
		if ( false === $valid_dependencies ) {
			wp_send_json_error( '依赖关系会形成循环或包含不存在的任务' );
		}
	}

	if ( $update ) {
		$wpdb->update( $table, $update, [ 'id' => $id ], $format, [ '%d' ] );
	}
	if ( $dependencies_changed ) {
		document_todo_save_dependencies( $id, $valid_dependencies );
	}

	$row = $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM $table WHERE id = %d", $id ),
		ARRAY_A
	);
	$rows = [ $row ];
	document_todo_attach_dependencies( $rows );
	$row = $rows[0];

	wp_send_json_success( $row );
}
add_action( 'wp_ajax_todo_update', 'document_todo_update' );

/**
 * 删除待办
 */
function document_todo_delete() {
	document_todo_check_permission();
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';

	$id = intval( $_POST['id'] ?? 0 );
	if ( ! $id ) {
		wp_send_json_error( 'ID无效' );
	}

	$parent_id = $wpdb->get_var( $wpdb->prepare( "SELECT parent_id FROM $table WHERE id = %d", $id ) );
	if ( $parent_id ) {
		$wpdb->query( $wpdb->prepare( "UPDATE $table SET parent_id = %d WHERE parent_id = %d", $parent_id, $id ) );
	} else {
		$wpdb->query( $wpdb->prepare( "UPDATE $table SET parent_id = NULL WHERE parent_id = %d", $id ) );
	}
	$edge_table = document_todo_dependencies_table();
	$wpdb->query( $wpdb->prepare( "DELETE FROM $edge_table WHERE task_id = %d OR depends_on_id = %d", $id, $id ) );
	$wpdb->delete( $table, [ 'id' => $id ], [ '%d' ] );
	wp_send_json_success( [ 'deleted' => $id ] );
}
add_action( 'wp_ajax_todo_delete', 'document_todo_delete' );

/**
 * 批量更新排序
 */
function document_todo_reorder() {
	document_todo_check_permission();
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';

	$orders = json_decode( stripslashes( $_POST['orders'] ?? '[]' ), true );
	if ( ! is_array( $orders ) ) {
		wp_send_json_error( '数据格式错误' );
	}

	foreach ( $orders as $item ) {
		$id = absint( $item['id'] ?? 0 );
		$has_parent = array_key_exists( 'parent_id', $item );
		$parent_id = $has_parent ? absint( $item['parent_id'] ) : 0;
		if ( ! $id || ( $has_parent && $parent_id && ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $parent_id ) ) ) || ( $has_parent && ! document_todo_valid_parent( $id, $parent_id ) ) ) {
			continue;
		}
		$update = [ 'sort_order' => intval( $item['sort_order'] ) ];
		$format = [ '%d' ];
		if ( $has_parent ) {
			$update['parent_id'] = $parent_id ?: null;
			$format[] = '%d';
		}
		$wpdb->update(
			$table,
			$update,
			[ 'id' => $id ],
			$format,
			[ '%d' ]
		);
	}

	wp_send_json_success( true );
}
add_action( 'wp_ajax_todo_reorder', 'document_todo_reorder' );

/**
 * 获取番茄钟状态（多端同步）
 */
function document_pomodoro_get() {
	document_todo_check_permission();
	$state   = get_option( 'document_pomodoro_state', '[]' );
	$counts  = get_option( 'document_pomodoro_counts', '{}' );
	$minutes = get_option( 'document_pomodoro_minutes', '{}' );
	wp_send_json_success( [
		'state'   => json_decode( $state, true ) ?: [],
		'counts'  => json_decode( $counts, true ) ?: new \stdClass(),
		'minutes' => json_decode( $minutes, true ) ?: new \stdClass(),
	] );
}
add_action( 'wp_ajax_pomodoro_get', 'document_pomodoro_get' );

/**
 * 保存番茄钟状态（多端同步）
 */
function document_pomodoro_save() {
	document_todo_check_permission();
	$state   = stripslashes( $_POST['state'] ?? '[]' );
	$counts  = stripslashes( $_POST['counts'] ?? '{}' );
	$minutes = stripslashes( $_POST['minutes'] ?? '{}' );
	// 基本校验
	if ( ! is_array( json_decode( $state, true ) ) ) $state = '[]';
	if ( ! is_object( json_decode( $counts ) ) && ! is_array( json_decode( $counts, true ) ) ) $counts = '{}';
	if ( ! is_object( json_decode( $minutes ) ) && ! is_array( json_decode( $minutes, true ) ) ) $minutes = '{}';
	update_option( 'document_pomodoro_state', $state, false );
	update_option( 'document_pomodoro_counts', $counts, false );
	update_option( 'document_pomodoro_minutes', $minutes, false );
	wp_send_json_success( true );
}
add_action( 'wp_ajax_pomodoro_save', 'document_pomodoro_save' );
