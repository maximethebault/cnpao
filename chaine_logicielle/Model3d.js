var inherit = require('inherit');
var _ = require('underscore');
var File = require('./File');
var Param = require('./Param');
var Process = require('./Process');
var poolModule = require('generic-pool');
var Utils = require('./Utils');
var Constants = require('./Constants');
var WebsocketConnection = require('./broadcast/WebsocketConnection');
var wrench = require('./file_utils/wrench.js');
var sqlCon = global.sqlCon;

/**
 * Un Model3d, un Process ou une Step possède les mêmes contrôles qu'un lecteur de musique :
 * -> un 'play', nommé dans le code start, qui (re)démarre un traitement
 * -> un 'pause', qui interrompt temporairement un traitement qui pourra être repris au même endroit ultérieurement (même s'il est parfois nécessaire de recommencer la Step qui avait été interrompue depuis le début)
 * -> un 'stop', qui stoppe un traitement : si on veut le relancer, il faut recommencer depuis le début
 *
 * Un Model3d peut se terminer de deux manières différentes :
 * -> l'utilisateur décide de stopper la génération du Model3d : la méthode stop est appelée et se propage aux Process et Step
 * -> le programme prend lui-même l'initiative de l'arrêt, décomposition en deux cas de figure :
 *      -> une erreur fatale est levée pendant l'éxécution d'une Step : les méthodes "error" des Step, Process et Model3d sont appelées successivement (propagées depuis une Step jusqu'au Model3d)
 *      -> il ne reste plus aucune Step, Process à éxécuter : les méthodes "done" des Step, Process et Model3d sont appelées successivement (propagées depuis une Step jusqu'au Model3d)
 */
var Model3d = inherit({
    __constructor: function(attrs) {
        this._attrs = attrs;
        this.basePath = 'data/' + attrs.id + '/';
        this.poolIdentifier = undefined;
        this.processCurrent = undefined;
        this.commandInProgress = false;
        // les broadcasts voulant être notifiés lors de la mise à jour du modèle courant
        this.userBroadcast = [];
        this.commandWatcher = setTimeout(this._commandWatch.bind(this), this.__self.watchInterval);
        // indique si le modèle 3d a été détruit
        this.destroyed = false;
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') créé');
    },
    _commandWatch: function() {
        var self = this;
        if(self.destroyed)
            return;
        sqlCon.query('SELECT command, delete_request FROM model3d WHERE id=? AND command<>state', [self._attrs.id], function(err, rows) {
            // on factorise dans la fonction suivante le code à exécuter après le lancement de l'ordre
            function resetTimer() {
                self.commandWatcher = setTimeout(self._commandWatch.bind(self), self.__self.watchInterval);
            }
            if(err) {
                var message = '[Model3d] Impossible de vérifier l\'état de l\'enregistrement ' + self._attrs.id + ' en BDD : ' + err + '.';
                console.error(message);
            }
            if(rows.length) {
                var delete_request = rows[0].delete_request;
                if(delete_request) {
                    if(self._attrs.state == Constants.STATE_STOPPED) {
                        self.destroy();
                    }
                    else {
                        self.stop(function(err) {
                            if(err)
                                console.error('[Model3d] Impossible d\'arrêter le processus : ' + err + '.');
                            resetTimer();
                        });
                    }
                }
                else {
                    var newCommand = rows[0].command;
                    if(newCommand == Constants.COMMAND_PAUSE) {
                        self.pause(false, function(err) {
                            if(err)
                                console.error('[Model3d] Impossible de mettre le processus en pause : ' + err + '.');
                            resetTimer();
                        });
                    }
                    else if(newCommand == Constants.COMMAND_RUN) {
                        self.start(function(err) {
                            if(err)
                                console.error('[Model3d] Impossible de démarrer le processus : ' + err + '.');
                            resetTimer();
                        });
                    }
                    else if(newCommand == Constants.COMMAND_STOP) {
                        self.stop(function(err) {
                            if(err)
                                console.error('[Model3d] Impossible d\'arrêter le processus : ' + err + '.');
                            resetTimer();
                        });
                    }
                    else {
                        console.error('[Model3d] La commande n\'a pas été comprise.');
                        resetTimer();
                    }
                }
            }
            else
                resetTimer();
        });
    },
    createFile: function(options, cb) {
        if(_.isFunction(options)) {
            cb = options;
            options = {};
        }
        _.extend(options, {model3d_id: this._attrs.id});
        File.create(options, this, cb);
    },
    file: function(options, cb) {
        if(_.isFunction(options)) {
            cb = options;
            options = {};
        }
        _.extend(options, {model3d_id: this._attrs.id});
        File.get(options, this, cb);
    },
    param: function(options, cb) {
        if(_.isFunction(options)) {
            cb = options;
            options = {};
        }
        _.extend(options, {model3d_id: this._attrs.id});
        Param.get(options, this, cb);
    },
    process: function(options, cb) {
        if(_.isFunction(options)) {
            cb = options;
            options = {};
        }
        _.extend(options, {model3d_id: this._attrs.id});
        Process.get(options, this, cb);
    },
    update: function(fields, cb) {
        var self = this;
        // on met à jour les attributs de l'objet
        _.extend(self._attrs, fields);
        sqlCon.query('UPDATE model3d SET ? WHERE id=?', [fields, self._attrs.id], function(err) {
            if(err) {
                var message = '[Model3d] Erreur lors de la mise à jour de l\'enregistrement ' + self._attrs.id + ' en BDD : ' + err + '.';
                console.error(message);
                if(cb)
                    cb(new Error(message), null);
                return;
            }
            if(cb)
                cb(null);
        });
    },
    /*
     * Démarre la chaine de traitement
     *
     * @param {Function} cb appelé quand le démarrage de la chaine de traitement est effectif
     */
    start: function(cb) {
        var self = this;
        // on empêche la possibilité de donner un ordre alors qu'un autre n'est pas terminé
        if(self.commandInProgress) {
            cb();
            return;
        }
        if(self._attrs.delete_request) {
            cb();
            self.destroy();
            return;
        }
        self.commandInProgress = true;
        if(self._attrs.state == Constants.STATE_STOPPED) {
            self.update({
                command: Constants.COMMAND_STOP,
                error: ''
            }, function() {
                self.commandInProgress = false;
            });
            return;
        }
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') lancé');
        self.__self.poolModel3d.acquire(function(err, poolIdentifier) {
            self.poolIdentifier = poolIdentifier;
            self.update({
                state: Constants.STATE_RUNNING
            }, function(err) {
                if(!err)
                    self.startNextProcess(cb);
                self.commandInProgress = false;
            });
        });
    },
    /**
     * Trouve le prochain Process à démarrer et le démarre
     *
     * @param {Function} cb appelé quand le démarrage du Process est effectif (lorsqu'une Step a été lancée)
     */
    startNextProcess: function(cb) {
        var self = this;
        self.process(function(err, processes) {
            if(err) {
                cb(err);
                return;
            }
            processes.sort(function(a, b) {
                return a._attrs.ordering - b._attrs.ordering;
            });
            self.processCurrent = undefined;
            for(var i = 0; i < processes.length; i++) {
                if(processes[i]._attrs.state == Constants.STATE_STOPPED)
                    continue;
                self.processCurrent = processes[i];
                self.processCurrent.start(cb);
                break;
            }
            if(!self.processCurrent) {
                self.done(function(err) {
                    if(err)
                        console.error("[Model3d] N'a pas pu mettre fin au Model3d : " + err);
                    cb(err);
                });
            }
        });
    },
    /**
     * Met en pause la chaine de traitement
     *
     * @param {boolean} hurry si le traitement actuel doit être interrompu dès que possible au risque de devoir par la suite recommencer la Step interrompue
     * @param {Function} cb appelé quand la mise en pause est effective, c'est-à-dire quand plus aucune Step lié à ce Model3d n'est en cours d'exécution
     */
    pause: function(hurry, cb) {
        var self = this;
        // on empêche la possibilité de donner un ordre alors qu'un autre n'est pas terminé
        if(self.commandInProgress) {
            cb();
            return;
        }
        self.commandInProgress = true;
        if(self._attrs.state == Constants.STATE_STOPPED) {
            self.update({
                command: Constants.COMMAND_STOP
            }, function() {
                self.commandInProgress = false;
            });
            return;
        }
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') mis en pause');
        if(self.processCurrent) {
            self.processCurrent.pause(hurry, function() {
                self.__self.poolModel3d.release(self.poolIdentifier);
                self.update({
                    state: Constants.STATE_PAUSED
                }, function(err) {
                    cb(err);
                    self.commandInProgress = false;
                });
            });
            return;
        }
        else {
            if(self.poolIdentifier)
                self.__self.poolModel3d.release(self.poolIdentifier);
            self.update({
                state: Constants.STATE_PAUSED
            }, function(err) {
                cb(err);
                self.commandInProgress = false;
            });
        }
    },
    /*
     *
     *
     * @param {Function} cb appelé quand la chaine de traitement est vraiment terminée
     */
    stop: function(cb) {
        var self = this;
        // on empêche la possibilité de donner un ordre alors qu'un autre n'est pas terminé
        if(self.commandInProgress) {
            cb();
            return;
        }
        self.commandInProgress = true;
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') arrêté');
        if(self.processCurrent) {
            self.processCurrent.stop(function() {
                self.__self.poolModel3d.release(self.poolIdentifier);
                self.update({
                    state: Constants.STATE_STOPPED
                }, function(err) {
                    cb(err);
                    self.commandInProgress = false;
                });
            });
            return;
        }
        else {
            if(self.poolIdentifier)
                self.__self.poolModel3d.release(self.poolIdentifier);
            self.update({
                state: Constants.STATE_STOPPED
            }, function(err) {
                cb(err);
                self.commandInProgress = false;
            });
        }
        self.removeCache();
    },
    /*
     * Signale une erreur avant de suspendre ou stopper le traitement
     *
     * @param {Error} err l'erreur rencontrée. Si elle est fatale (err.fatal === true), on pause le traitement, sinon, on se contente d'enregistrer le warning
     */
    error: function(err) {
        this.update({error: err, command: Constants.COMMAND_PAUSE});
        if(err.fatal)
            this.pause(true, function(err) {
                if(err)
                    console.error('[Model3d] Traitement (ID = ' + this._attrs.id + ') n\'a pas pu être mis en pause après signalement d\'une erreur !');
            });
    },
    /**
     * Réalise les traitements associés à la fin de génération d'un modèle
     */
    done: function(cb) {
        var self = this;
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') terminé');
        if(self.poolIdentifier)
            self.__self.poolModel3d.release(self.poolIdentifier);
        self.update({
            state: Constants.STATE_STOPPED
        }, function(err) {
            self.commandInProgress = false;
            self.processCurrent = null;
            self.removeCache();
            cb(err);
        });
    },
    destroy: function(cb) {
        var self = this;
        // on empêche la possibilité de donner un ordre alors qu'un autre n'est pas terminé
        if(self.commandInProgress) {
            if(cb)
                cb();
            return;
        }
        self.commandInProgress = true;
        console.info('[Model3d] Traitement (ID = ' + this._attrs.id + ') supprimé');
        // on commence par supprimer tout le répertoire 'data'
        wrench.rmdirRecursive(self.basePath, true, function(err) {
            if(err)
                console.error('[Model3d] Impossible de supprimer les fichiers associés au modèle ' + self._attrs.id + ' : ' + err + '.');
            sqlCon.query('DELETE p, s FROM process p LEFT JOIN step s ON p.id=s.process_id WHERE p.model3d_id=?', [self._attrs.id], function(err) {
                if(err)
                    console.error('[Model3d] Impossible de supprimer les Process & Step associés au modèle ' + self._attrs.id + ' : ' + err + '.');
            });
            sqlCon.query('DELETE FROM file WHERE model3d_id=?', [self._attrs.id], function(err) {
                if(err)
                    console.error('[Model3d] Impossible de supprimer les File associés au modèle ' + self._attrs.id + ' : ' + err + '.');
            });
            sqlCon.query('DELETE FROM param WHERE model3d_id=?', [self._attrs.id], function(err) {
                if(err)
                    console.error('[Model3d] Impossible de supprimer les Param associés au modèle ' + self._attrs.id + ' : ' + err + '.');
            });
            sqlCon.query('DELETE FROM model3d WHERE id=?', [self._attrs.id], function(err) {
                if(err)
                    console.error('[Model3d] Impossible de supprimer le  modèle ' + self._attrs.id + ' : ' + err + '.');
            });
            if(self.commandWatcher)
                clearTimeout(self.commandWatcher);
            self.destroyed = true;
            self.removeCache();
            if(cb)
                cb();
        });
    },
    sendNotification: function(message) {
        message.model3d_id = this._attrs.id;
        WebsocketConnection.sendNotification(this._attrs.user_id, message);
    },
    removeCache: function() {
        this.__self.removeCache(this._attrs.id);
        Process.removeCache(this);
        File.removeCache(this);
        Param.removeCache(this);
    }
}, {
    // l'intervalle en millisecondes entre chaque vérification pour de nouvelles générations à démarrer
    checkInterval: 5000,
    // l'intervalle en millisecondes entre chaque vérification de nouvel ordre pour un Model3d
    watchInterval: 1000,
    poolUniqueIdentifier: 1,
    poolModel3d: poolModule.Pool({
        name: 'model3d',
        create: function(callback) {
            callback(null, Model3d.poolUniqueIdentifier++);
        },
        destroy: function() {
        },
        // si on veut augmenter le nombre de Process traités en parallèle, on pourra augmenter le nombre suivant
        max: 1,
        refreshIdle: false
    }),
    tabCachedModels: {},
    get: function(cond, cb) {
        var self = this;
        var queryArgs = Utils.getQueryArgs(cond);
        sqlCon.query('SELECT * FROM model3d WHERE ' + queryArgs.where, queryArgs.args, function(err, rows) {
            if(err) {
                var message = '[Model3d] Erreur lors de la récupération des enregistrements en BDD : ' + err + '.';
                console.error(message);
                cb(new Error(message), null);
                return;
            }
            var tabModels = _.map(rows, function(row) {
                if(self.tabCachedModels.hasOwnProperty(row.id))
                    _.extend(self.tabCachedModels[row.id]._attrs, row);
                else
                    self.tabCachedModels[row.id] = new Model3d(row);
                return self.tabCachedModels[row.id];
            });
            cb(null, tabModels);
        });
    },
    /**
     * Pour pouvoir ré-utiliser les mêmes objects entre chaque pause, ils sont mis en cache dans des tableaux associatifs (en JavaScript, ce sont tout simplement des objets) : tabCachedModels
     * On peut rencontrer les mêmes problèmes qu'en Java : tant qu'on garde une référence vers un objet, il ne sera pas nettoyé par le Garbage Collector : c'est donc le problème que résout cette fonction
     */
    removeCache: function(id) {
        delete this.tabCachedModels[id];
    }
});

module.exports = Model3d;