<div class="model3d-progress-{%=o.id%} hc-model3d-form" style="position: relative; border: #aaaaaa solid 1px; border-radius: 20px; margin: 20px; padding: 20px;">
	<span class="hc-btn-delte model3d-delete-{%=o.id%}">
    	<img src="images/delete.png" alt="delete" title="delete"/>
	</span>
    <div>
        <h3>Génération de modèle 3D</h3>
        <table class="model3d-selector-table">
            <tr>
                <td>
                    <?php
                    $processes = SpecProcess::find('all', array('include' => 'specParam', 'order' => 'ordering ASC'));
                    $order = -1;
                    foreach($processes as $process) {
                        if($order < $process->ordering && $order !== -1) {
                            echo '</td><td>';
                        }
                        echo '<span class="process{% if(o.process[' . $process->id . '] && o.process[' . $process->id . '].state == 0) { %} process-selected{% } else if(o.process[' . $process->id . '] && o.process[' . $process->id . '].state == 1) { %} process-loading{% } else if(o.process[' . $process->id . '] && o.process[' . $process->id . '].state == 2) { %} process-done{% } %}" data-process-id="' . $process->id . '" data-model3d-id="{%=o.id%}">' . $process->name . '</span>';
                        $order = $process->ordering;
                    }
                    ?>
                </td>
            </tr>
        </table>
        <div class="model3d-steps">
            <?php
            foreach($processes as $process) {
                echo '<div class="model3d-step model3d-step-' . $process->id . '{% if(!o.process[' . $process->id . ']) { %} hidden{% } %}">';
                echo '<h2>' . $process->name . '</h2>';
                $i = 1;
                foreach($process->specStep as $step) {
                    echo '<span class="step-name">' . $i . '. ' . $step->name . '</span>';
                    ?>
                    <div class="progress{% if(o.step[<?php echo $step->id; ?>] && o.step[<?php echo $step->id; ?>].state === 1) { %} progress-striped active{% } %}">
                        <div class="progress-bar progress-bar-{% if(o.step[<?php echo $step->id; ?>]) { %}{%=o.step[<?php echo $step->id; ?>].id%}{% } %}{% if(o.step[<?php echo $step->id; ?>] && o.step[<?php echo $step->id; ?>].state === 2) { %} progress-bar-success{% } %}" role="progressbar" aria-valuenow="{% if(o.step[<?php echo $step->id; ?>]) { %}{%=o.step[<?php echo $step->id; ?>].progress%}{% } %}" aria-valuemin="0" aria-valuemax="100" style="width: {% if(o.step[<?php echo $step->id; ?>]) { %}{%=o.step[<?php echo $step->id; ?>].progress%}{% } %}%">
                        </div>
                    </div>
                    <?php
                    $i++;
                }
                echo '</div>';
            }
            ?>
        </div>
        <br />
        <div class="model3d-dl{% if(!o.isDone) { %} hidden{% } %}">
            <table class="table table-striped">
                <tr>
                    <th>Type</th>
                    <th>Nom</th>
                    <th>Taille</th>
                    <th>Télécharger</th>
                </tr>
                {%
                for(var file in o.files) {
                %}
                <tr>
                    <td>{%=o.files[file].type%}</td>
                    <td>{%=o.files[file].name%}</td>
                    <td>{%=o.files[file].size_bella%}</td>
                    <td>
                        <a href="download.php?file_id={%=o.files[file].id%}">
                            <span class="btn btn-success fileinput-button">
                                <i class="glyphicon glyphicon-download"></i>
                                <span>Télécharger</span>
                            </span>
                        </a>
                    </td>
                </tr>
                {%
                }
                %}
            </table>
        </div>
    </div>
</div>