<?php

/*
 * 文章加密时，请求输入密码
 * @author 友人a丶
 * @date 2022-07-08
 * */


$url     = get_cdn_uri();//主题url
$protect = $url . '/assets/images/empty.svg';
?>
    <div class="password">
        <img src="<?php echo $protect; ?>" alt="password" style="">
		<?php echo get_the_password_form(); ?>
    </div>
<?php get_template_part( './template/index/fixed' ); ?>