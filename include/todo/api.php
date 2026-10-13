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
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( '无权限', 403 );
	}
	if ( ! check_ajax_referer( 'document_nonce', 'nonce', false ) ) {
		wp_send_json_error( '请求已过期，请刷新页面后重试', 403 );
	}
}

function document_todo_table_exists( $table ) {
	global $wpdb;
	return $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) === $table;
}

function document_todo_task( $id ) {
	global $wpdb;
	$table = $wpdb->prefix . 'document_todos';
	$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $table WHERE id = %d", (int) $id ), ARRAY_A );
	return $wpdb->last_error ? new WP_Error( 'database_error', '读取待办事项失败' ) : $row;
}

function document_todo_parse_due_date( $raw, &$valid ) {
	$valid = true;
	$value = sanitize_text_field( is_scalar( $raw ) ? $raw : '' );
	if ( '' === $value ) {
		return null;
	}
	$date = DateTime::createFromFormat( 'Y-m-d', $value );
	$errors = DateTime::getLastErrors();
	if ( false === $date || ( is_array( $errors ) && ( $errors['warning_count'] || $errors['error_count'] ) ) || $date->format( 'Y-m-d' ) !== $value ) {
		$valid = false;
		return null;
	}
	return $value;
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
		$parent = $wpdb->get_var( $wpdb->prepare(
			"SELECT parent_id FROM $table WHERE id = %d",
			$cursor
		) );
		if ( '' === $parent || null === $parent ) {
			if ( $wpdb->last_error ) {
				return false;
			}
			$cursor = 0;
		} else {
			$cursor = (int) $parent;
		}
	}

	return 0 === $cursor;
}

function document_todo_valid_parent_map( $id, $parent_id, $parents ) {
	if ( ! $parent_id || (int) $id === (int) $parent_id ) {
		return ! $parent_id;
	}
	$cursor = (int) $parent_id;
	$seen   = [];
	for ( $i = 0; $i <= count( $parents ); $i++ ) {
		if ( $cursor === (int) $id || isset( $seen[ $cursor ] ) ) {
			return false;
		}
		$seen[ $cursor ] = true;
		$cursor = isset( $parents[ $cursor ] ) ? (int) $parents[ $cursor ] : 0;
		if ( ! $cursor ) {
			return true;
		}
	}
	return false;
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

function document_todo_parse_dependencies( $raw, &$valid ) {
	$valid = true;
	if ( is_array( $raw ) ) {
		$decoded = $raw;
	} else {
		$text = stripslashes( (string) $raw );
		$decoded = json_decode( $text, true );
		if ( JSON_ERROR_NONE !== json_last_error() || ! is_array( $decoded ) ) {
			$valid = false;
			return [];
		}
	}

	$ids = [];
	foreach ( $decoded as $value ) {
		if ( ! is_int( $value ) && ( ! is_string( $value ) || ! preg_match( '/^[1-9][0-9]*$/', $value ) ) ) {
			$valid = false;
			return [];
		}
		$id = absint( $value );
		if ( ! $id ) {
			$valid = false;
			return [];
		}
		$ids[ $id ] = $id;
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
		return new WP_Error( 'dependency_self', '任务不能依赖自己' );
	}
	foreach ( $dependency_ids as $dependency_id ) {
		if ( ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $dependency_id ) ) ) {
			if ( $wpdb->last_error ) {
				return new WP_Error( 'database_error', '读取前置任务失败' );
			}
			return new WP_Error( 'dependency_missing', '前置任务不存在' );
		}
	}

	$edges = $wpdb->get_results( "SELECT task_id, depends_on_id FROM $edge_table", ARRAY_A );
	if ( null === $edges && $wpdb->last_error ) {
		return new WP_Error( 'database_error', '读取依赖关系失败' );
	}
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
				return new WP_Error( 'dependency_cycle', '依赖关系会形成循环' );
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
	if ( false === $wpdb->delete( $edge_table, [ 'task_id' => (int) $task_id ], [ '%d' ] ) ) {
		return false;
	}
	foreach ( $dependency_ids as $dependency_id ) {
		if ( false === $wpdb->insert(
			$edge_table,
			[ 'task_id' => (int) $task_id, 'depends_on_id' => (int) $dependency_id ],
			[ '%d', '%d' ]
		) ) {
			return false;
		}
	}
	return true;
}

function document_todo_attach_dependencies( &$rows ) {
	global $wpdb;
	$edge_table = document_todo_dependencies_table();
	$edges = $wpdb->get_results( "SELECT task_id, depends_on_id FROM $edge_table", ARRAY_A );
	if ( null === $edges && $wpdb->last_error ) {
		return false;
	}
	$dependencies = [];
	foreach ( $edges as $edge ) {
		$dependencies[ (string) $edge['task_id'] ][] = (int) $edge['depends_on_id'];
	}
	foreach ( $rows as &$row ) {
		$row['dependencies'] = $dependencies[ (string) $row['id'] ] ?? [];
	}
	unset( $row );
	return true;
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
	if ( null === $rows && $wpdb->last_error ) {
		wp_send_json_error( '读取待办事项失败', 500 );
	}
	if ( ! document_todo_attach_dependencies( $rows ) ) {
		wp_send_json_error( '读取前置任务失败', 500 );
	}

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
	$due_date = document_todo_parse_due_date( $_POST['due_date'] ?? '', $due_date_valid );
	$importance = intval( $_POST['importance'] ?? 3 );
	$notes    = sanitize_textarea_field( $_POST['notes'] ?? '' );
	$parent_id = absint( $_POST['parent_id'] ?? 0 );
	$dependencies = document_todo_parse_dependencies( $_POST['dependencies'] ?? [], $dependencies_valid );

	if ( empty( $title ) ) {
		wp_send_json_error( '标题不能为空' );
	}
	if ( ! $due_date_valid ) {
		wp_send_json_error( '截止日期格式无效' );
	}
	if ( ! $dependencies_valid ) {
		wp_send_json_error( '前置任务格式无效' );
	}

	if ( ! in_array( $priority, document_todo_allowed_priorities(), true ) ) {
		wp_send_json_error( '优先级无效' );
	}
	$parent = $parent_id ? document_todo_task( $parent_id ) : null;
	if ( is_wp_error( $parent ) ) {
		wp_send_json_error( $parent->get_error_message(), 500 );
	}
	if ( $parent_id && ! $parent ) {
		wp_send_json_error( '父任务不存在' );
	}
	if ( $parent_id && ! document_todo_valid_parent( 0, $parent_id ) ) {
		wp_send_json_error( '父任务关系无效' );
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

	if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
		wp_send_json_error( '无法开始数据库事务', 500 );
	}
	if ( false === $wpdb->insert( $table, $data, $format ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '创建待办事项失败', 500 );
	}
	$id = $wpdb->insert_id;
	$valid_dependencies = document_todo_valid_dependencies( $id, $dependencies );
	if ( is_wp_error( $valid_dependencies ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( $valid_dependencies->get_error_message() );
	}
	if ( ! document_todo_save_dependencies( $id, $valid_dependencies ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '保存前置任务失败', 500 );
	}
	if ( false === $wpdb->query( 'COMMIT' ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '提交待办事项失败', 500 );
	}

	$row = $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM $table WHERE id = %d", $id ),
		ARRAY_A
	);
	if ( ! $row ) {
		wp_send_json_error( '创建成功但读取结果失败', 500 );
	}
	$rows = [ $row ];
	if ( ! document_todo_attach_dependencies( $rows ) ) {
		wp_send_json_error( '读取前置任务失败', 500 );
	}
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
	$task = document_todo_task( $id );
	if ( is_wp_error( $task ) ) {
		wp_send_json_error( $task->get_error_message(), 500 );
	}
	if ( ! $task ) {
		wp_send_json_error( '待办事项不存在', 404 );
	}

	$update = [];
	$format = [];
	$dependencies_changed = isset( $_POST['dependencies'] );
	$dependencies = $dependencies_changed ? document_todo_decode_dependencies( $_POST['dependencies'] ) : [];

	if ( isset( $_POST['title'] ) ) {
		$update['title'] = sanitize_text_field( $_POST['title'] );
		if ( '' === $update['title'] ) {
			wp_send_json_error( '标题不能为空' );
		}
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
		} else {
			$update['archived_at'] = null;
			$format[] = '%s';
		}
	}
	if ( isset( $_POST['priority'] ) ) {
		$p = sanitize_text_field( $_POST['priority'] );
		if ( ! in_array( $p, document_todo_allowed_priorities(), true ) ) {
			wp_send_json_error( '优先级无效' );
		}
		$update['priority'] = $p;
		$format[]           = '%s';
	}
	if ( isset( $_POST['parent_id'] ) ) {
		$parent_id = absint( $_POST['parent_id'] );
		if ( $parent_id && ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $table WHERE id = %d", $parent_id ) ) ) {
			if ( $wpdb->last_error ) {
				wp_send_json_error( '读取父任务失败', 500 );
			}
			wp_send_json_error( '父任务不存在' );
		}
		if ( ! document_todo_valid_parent( $id, $parent_id ) ) {
			wp_send_json_error( '不能把任务移动到自己的子任务下面' );
		}
		$update['parent_id'] = $parent_id ?: null;
		$format[]            = '%d';
	}
	if ( isset( $_POST['due_date'] ) ) {
		$update['due_date'] = document_todo_parse_due_date( $_POST['due_date'], $due_date_valid );
		if ( ! $due_date_valid ) {
			wp_send_json_error( '截止日期格式无效' );
		}
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
		$valid_dependencies = document_todo_parse_dependencies( $_POST['dependencies'], $dependencies_valid );
		if ( ! $dependencies_valid ) {
			wp_send_json_error( '前置任务格式无效' );
		}
		$valid_dependencies = document_todo_valid_dependencies( $id, $valid_dependencies );
		if ( is_wp_error( $valid_dependencies ) ) {
			wp_send_json_error( $valid_dependencies->get_error_message() );
		}
	}

	if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
		wp_send_json_error( '无法开始数据库事务', 500 );
	}
	if ( $update ) {
		if ( false === $wpdb->update( $table, $update, [ 'id' => $id ], $format, [ '%d' ] ) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '更新待办事项失败', 500 );
		}
	}
	if ( $dependencies_changed ) {
		if ( ! document_todo_save_dependencies( $id, $valid_dependencies ) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '保存前置任务失败', 500 );
		}
	}
	if ( false === $wpdb->query( 'COMMIT' ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '提交待办事项失败', 500 );
	}

	$row = $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM $table WHERE id = %d", $id ),
		ARRAY_A
	);
	if ( ! $row ) {
		wp_send_json_error( '更新成功但读取结果失败', 500 );
	}
	$rows = [ $row ];
	if ( ! document_todo_attach_dependencies( $rows ) ) {
		wp_send_json_error( '读取前置任务失败', 500 );
	}
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
	$task = document_todo_task( $id );
	if ( is_wp_error( $task ) ) {
		wp_send_json_error( $task->get_error_message(), 500 );
	}
	if ( ! $task ) {
		wp_send_json_error( '待办事项不存在', 404 );
	}

	$parent_id = $wpdb->get_var( $wpdb->prepare( "SELECT parent_id FROM $table WHERE id = %d", $id ) );
	if ( null === $parent_id && $wpdb->last_error ) {
		wp_send_json_error( '读取待办事项失败', 500 );
	}
	if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
		wp_send_json_error( '无法开始数据库事务', 500 );
	}
	if ( $parent_id ) {
		if ( false === $wpdb->query( $wpdb->prepare( "UPDATE $table SET parent_id = %d WHERE parent_id = %d", $parent_id, $id ) ) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '转移子任务失败', 500 );
		}
	} else {
		if ( false === $wpdb->query( $wpdb->prepare( "UPDATE $table SET parent_id = NULL WHERE parent_id = %d", $id ) ) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '解除子任务关系失败', 500 );
		}
	}
	$edge_table = document_todo_dependencies_table();
	if ( false === $wpdb->query( $wpdb->prepare( "DELETE FROM $edge_table WHERE task_id = %d OR depends_on_id = %d", $id, $id ) ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '删除前置任务关系失败', 500 );
	}
	if ( false === $wpdb->delete( $table, [ 'id' => $id ], [ '%d' ] ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '删除待办事项失败', 500 );
	}
	if ( false === $wpdb->query( 'COMMIT' ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '提交待办事项失败', 500 );
	}
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

	$seen_ids = [];
	$parents = $wpdb->get_results( "SELECT id, parent_id FROM $table", ARRAY_A );
	if ( null === $parents && $wpdb->last_error ) {
		wp_send_json_error( '读取任务层级失败', 500 );
	}
	$parent_map = [];
	foreach ( $parents ?: [] as $parent_row ) {
		$parent_map[ (int) $parent_row['id'] ] = (int) $parent_row['parent_id'];
	}
	$pending_parents = $parent_map;
	foreach ( $orders as $item ) {
		if ( is_array( $item ) && array_key_exists( 'parent_id', $item ) ) {
			$pending_parents[ absint( $item['id'] ?? 0 ) ] = absint( $item['parent_id'] );
		}
	}
	foreach ( $orders as $item ) {
		if ( ! is_array( $item ) || ! array_key_exists( 'parent_id', $item ) ) {
			continue;
		}
		$check_id = absint( $item['id'] ?? 0 );
		$check_parent = absint( $item['parent_id'] );
		if ( ! $check_id || ( $check_parent && ! isset( $parent_map[ $check_parent ] ) ) || ! document_todo_valid_parent_map( $check_id, $check_parent, $pending_parents ) ) {
			wp_send_json_error( '父任务关系无效' );
		}
	}
	if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
		wp_send_json_error( '无法开始数据库事务', 500 );
	}
	foreach ( $orders as $item ) {
		if ( ! is_array( $item ) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '排序数据格式错误' );
		}
		$id = absint( $item['id'] ?? 0 );
		$task = null;
		$has_parent = array_key_exists( 'parent_id', $item );
		$parent_id = $has_parent ? absint( $item['parent_id'] ) : 0;
		$task = $id ? document_todo_task( $id ) : null;
		if ( ! $id || isset( $seen_ids[ $id ] ) || is_wp_error( $task ) || ! $task ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( is_wp_error( $task ) ? $task->get_error_message() : '排序任务无效', is_wp_error( $task ) ? 500 : 400 );
		}
		$seen_ids[ $id ] = true;
		$update = [ 'sort_order' => intval( $item['sort_order'] ) ];
		$format = [ '%d' ];
		if ( $has_parent ) {
			$update['parent_id'] = $parent_id ?: null;
			$format[] = '%d';
		}
		if ( false === $wpdb->update(
			$table,
			$update,
			[ 'id' => $id ],
			$format,
			[ '%d' ]
		) ) {
			$wpdb->query( 'ROLLBACK' );
			wp_send_json_error( '保存排序失败', 500 );
		}
	}

	if ( false === $wpdb->query( 'COMMIT' ) ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_error( '提交排序失败', 500 );
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
