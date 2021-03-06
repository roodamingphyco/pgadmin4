//////////////////////////////////////////////////////////////////////////
//
// pgAdmin 4 - PostgreSQL Tools
//
// Copyright (C) 2013 - 2018, The pgAdmin Development Team
// This software is released under the PostgreSQL Licence
//
//////////////////////////////////////////////////////////////////////////

import gettext from '../gettext';
import $ from 'jquery';
import url_for from '../url_for';
import axios from 'axios';
import * as transaction from './is_new_transaction_required';

class LoadingScreen {
  constructor(sqlEditor) {
    this.sqlEditor = sqlEditor;
  }

  setMessage(message) {
    this.sqlEditor.trigger(
      'pgadmin-sqleditor:loading-icon:message',
      gettext(message)
    );
  }

  show(withMessage) {
    this.sqlEditor.trigger(
      'pgadmin-sqleditor:loading-icon:show',
      withMessage
    );
  }

  hide() {
    this.sqlEditor.trigger('pgadmin-sqleditor:loading-icon:hide');
  }
}

class ExecuteQuery {
  constructor(sqlEditor, userManagement) {
    this.sqlServerObject = sqlEditor;
    this.loadingScreen = new LoadingScreen(sqlEditor);
    this.userManagement = userManagement;
  }

  delayedPoll() {
    const self = this;
    setTimeout(
      () => {
        self.poll();
      }, self.sqlServerObject.POLL_FALLBACK_TIME());
  }

  execute(sqlStatement, explainPlan) {
    // If it is an empty query, do nothing.
    if (sqlStatement.length <= 0) return;

    const self = this;
    let service = axios.create({});
    self.explainPlan = explainPlan;

    const sqlStatementWithAnalyze = ExecuteQuery.prepareAnalyzeSql(sqlStatement, explainPlan);

    self.initializeExecutionOnSqlEditor(sqlStatementWithAnalyze);

    service.post(
      url_for('sqleditor.query_tool_start', {
        'trans_id': self.sqlServerObject.transId,
      }),
      JSON.stringify(sqlStatementWithAnalyze),
      {headers: {'Content-Type': 'application/json'}})
      .then(function (result) {
        let httpMessageData = result.data;
        self.removeGridViewMarker();

        if (ExecuteQuery.isSqlCorrect(httpMessageData)) {
          self.loadingScreen.setMessage('Waiting for the query execution to complete...');

          self.updateSqlEditorStateWithInformationFromServer(httpMessageData.data);

          // If status is True then poll the result.
          self.delayedPoll();
        } else {
          self.loadingScreen.hide();
          self.enableSQLEditorButtons();
          self.sqlServerObject.update_msg_history(false, httpMessageData.data.result);

          // Highlight the error in the sql panel
          self.sqlServerObject._highlight_error(httpMessageData.data.result);
        }
      }).catch(function (error) {
        self.onExecuteHTTPError(error.response.data);
      }
    );
  }

  poll() {
    const self = this;
    let service = axios.create({});
    service.get(
      url_for('sqleditor.poll', {
        'trans_id': self.sqlServerObject.transId,
      })
    ).then(
      (httpMessage) => {
        if (ExecuteQuery.isQueryFinished(httpMessage)) {
          self.loadingScreen.setMessage('Loading data from the database server and rendering...');

          self.sqlServerObject.call_render_after_poll(httpMessage.data.data);
        } else if (ExecuteQuery.isQueryStillRunning(httpMessage)) {
          // If status is Busy then poll the result by recursive call to the poll function
          this.delayedPoll();
          self.sqlServerObject.setIsQueryRunning(true);
          if (httpMessage.data.data.result) {
            self.sqlServerObject.update_msg_history(httpMessage.data.data.status, httpMessage.data.data.result, false);
          }
        } else if (ExecuteQuery.isConnectionToServerLostWhilePolling(httpMessage)) {
          self.loadingScreen.hide();
          // Enable/Disable query tool button only if is_query_tool is true.
          if (self.sqlServerObject.is_query_tool) {
            self.enableSQLEditorButtons();
          }
          self.sqlServerObject.update_msg_history(false, httpMessage.data.data.result, true);
        } else if (ExecuteQuery.isQueryCancelled(httpMessage)) {
          self.loadingScreen.hide();
          self.sqlServerObject.update_msg_history(false, 'Execution Cancelled!', true);
        }
      }
    ).catch(
      error => {
        const errorData = error.response.data;
        // Enable/Disable query tool button only if is_query_tool is true.
        self.sqlServerObject.resetQueryHistoryObject(self.sqlServerObject);
        self.loadingScreen.hide();
        if (self.sqlServerObject.is_query_tool) {
          self.enableSQLEditorButtons();
        }

        if (ExecuteQuery.wasConnectionLostToServer(errorData)) {
          self.handleConnectionToServerLost();
          return;
        }
        if (self.userManagement.is_pga_login_required(errorData)) {
          return self.userManagement.pga_login();
        }

        let msg = ExecuteQuery.extractErrorMessage(errorData);

        self.sqlServerObject.update_msg_history(false, msg);
        // Highlight the error in the sql panel
        self.sqlServerObject._highlight_error(msg);
      });
  }

  initializeExecutionOnSqlEditor(sqlStatement) {
    this.loadingScreen.show('Initializing query execution...');

    $('#btn-flash').prop('disabled', true);

    this.sqlServerObject.query_start_time = new Date();
    if(typeof sqlStatement === 'object') {
      this.sqlServerObject.query = sqlStatement['sql'];
    } else {
      this.sqlServerObject.query = sqlStatement;
    }

    this.sqlServerObject.rows_affected = 0;
    this.sqlServerObject._init_polling_flags();
    this.disableSQLEditorButtons();
  }

  static prepareAnalyzeSql(sqlStatement, analyzeSql) {
    let sqlStatementWithAnalyze = {
      sql: sqlStatement,
      explain_plan: analyzeSql,
    };
    return sqlStatementWithAnalyze;
  }

  onExecuteHTTPError(httpMessage) {
    this.loadingScreen.hide();
    this.enableSQLEditorButtons();

    if (ExecuteQuery.wasConnectionLostToServer(httpMessage)) {
      this.handleConnectionToServerLost();
      return;
    }

    if (this.userManagement.is_pga_login_required(httpMessage)) {
      this.sqlServerObject.save_state('execute', [this.explainPlan]);
      this.userManagement.pga_login();
    }

    if (transaction.is_new_transaction_required(httpMessage)) {
      this.sqlServerObject.save_state('execute', [this.explainPlan]);
      this.sqlServerObject.init_transaction();
    }

    let msg = httpMessage.errormsg;
    if (httpMessage.responseJSON !== undefined) {
      if (httpMessage.responseJSON.errormsg !== undefined) {
        msg = httpMessage.responseJSON.errormsg;
      }

      if (httpMessage.status === 503 && httpMessage.responseJSON.info !== undefined &&
        httpMessage.responseJSON.info === 'CONNECTION_LOST') {
        setTimeout(function () {
          this.sqlServerObject.save_state('execute', [this.explainPlan]);
          this.sqlServerObject.handle_connection_lost(false, httpMessage);
        });
      }
    }

    this.sqlServerObject.update_msg_history(false, msg);
  }

  removeGridViewMarker() {
    if (this.sqlServerObject.gridView.marker) {
      this.sqlServerObject.gridView.marker.clear();
      delete this.sqlServerObject.gridView.marker;
      this.sqlServerObject.gridView.marker = null;

      // Remove already existing marker
      this.sqlServerObject.gridView.query_tool_obj.removeLineClass(this.sqlServerObject.marked_line_no, 'wrap', 'CodeMirror-activeline-background');
    }
  }

  enableSQLEditorButtons() {
    this.sqlServerObject.disable_tool_buttons(false);
    $('#btn-cancel-query').prop('disabled', true);
  }

  disableSQLEditorButtons() {
    this.sqlServerObject.disable_tool_buttons(true);
    $('#btn-cancel-query').prop('disabled', false);
  }

  static wasConnectionLostToServer(errorMessage) {
    return errorMessage.readyState === 0;
  }

  handleConnectionToServerLost() {
    this.sqlServerObject.update_msg_history(false,
      gettext('Not connected to the server or the connection to the server has been closed.')
    );
  }

  updateSqlEditorStateWithInformationFromServer(messageData) {
    this.sqlServerObject.can_edit = messageData.can_edit;
    this.sqlServerObject.can_filter = messageData.can_filter;
    this.sqlServerObject.info_notifier_timeout = messageData.info_notifier_timeout;
  }

  static isSqlCorrect(httpMessageData) {
    return httpMessageData.data.status;
  }

  static extractErrorMessage(httpMessage) {
    let msg = httpMessage.errormsg;
    if (httpMessage.responseJSON !== undefined &&
      httpMessage.responseJSON.errormsg !== undefined)
      msg = httpMessage.responseJSON.errormsg;

    return msg;
  }

  static isQueryFinished(httpMessage) {
    return httpMessage.data.data.status === 'Success';
  }

  static isQueryStillRunning(httpMessage) {
    return httpMessage.data.data.status === 'Busy';
  }

  static isQueryCancelled(httpMessage) {
    return httpMessage.data.data.status === 'Cancel';
  }

  static isConnectionToServerLostWhilePolling(httpMessage) {
    return httpMessage.data.data.status === 'NotConnected';
  }
}

module.exports = {
  ExecuteQuery: ExecuteQuery,
};
