<?php
header("Expires: Mon, 26 Jul 1997 05:00:00 GMT");
session_start();
if(!array_key_exists('id', $_SESSION))
    die;
require_once '../../../config.php';
require_once '../libs/loadActiveRecord.php';

$model3d = Model3d::find(intval($_REQUEST['id']));
if($model3d->membres_id == $_SESSION['id']) {
    if(array_key_exists('name', $_POST))
        $model3d->name = $_POST['name'];
    if(array_key_exists('order', $_POST))
        $model3d->order = $_POST['order'];
    $model3d->save();
    echo $model3d->to_json();
}
else {
    die(json_encode(array('error' => 1, 'message' => "Vous n'avez pas les autorisations nécessaires !")));
}