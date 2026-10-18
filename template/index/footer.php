<?php

/*
 * 全局底部模板
 * @author 友人a丶
 * @date 2022-07-08
 * */

?>
<div class="main-bottom">
    <?php nicen_theme_config('document_footer_extra');//额外代码?>
    <span class="rss-subscribe-link">
        <span aria-hidden="true"> · </span>
        <a href="<?php echo esc_url( get_feed_link( 'rss2' ) ); ?>" rel="alternate" type="application/rss+xml" title="订阅 RSS">RSS</a>
    </span>
</div>
