import React from 'react';
import Moment from 'moment';
import $ from 'jquery';
import _ from 'underscore';

import { PageHeader, Alert, Panel, Button, Table, Row, Col } from 'react-bootstrap';

import DateTimePicker from 'react-bootstrap-datetimepicker';

/* Utilities */
import Spinner from '../components/Spinner.jsx';
import CodeLookups from '../utils/CodeLookups';
import FileSearchForm from '../components/FileSearchForm.jsx';
import { SEARCH_MODE_PARAMS } from '../components/FileSearchForm.jsx';

import api from '../utils/api';

/* Models and Collections */
import currentUser from '../user';
import CaseSearchResponse from '../models/CaseSearchResponse';
import CaseSearchProgress from '../components/CaseSearchProgress.jsx';
import CaseDetail from '../models/CaseDetail';
import CaseDetails from '../collections/CaseDetails';
import Tapeman from '../collections/TapemanCollection';


var CaseSearch = React.createClass({
  propTypes: {
    location: React.PropTypes.object.isRequired,
  },

  contextTypes: {
    router: React.PropTypes.object.isRequired,
  },

  getInitialState() {
    var query = this.props.location.query;
    var searchMode = _.findWhere(SEARCH_MODE_PARAMS, { mode: query.searchMode || 'FILENO' });

    // the file division code must be set to either 'criminal' or 'civil', otherwise we won't be able to call the correct files API
    var fileDivisionCd = query.fileDivisionCd || 'criminal';
    if (!_.contains(['criminal', 'civil', 'other'], fileDivisionCd)) { throw 'fileDivisionCdError'; }

    // Set caseFiles to a collection of zero or more CaseDetail type 1 which represent the (possibly empty) set of cases found by a search.
    //
    var locState = this.props.location.state;
    var existingSearchResults = (locState || {}).searchResults;
    var caseFiles;
    if (existingSearchResults === undefined) {
      caseFiles = new CaseDetails(); // search results are empty
    } else
      if (existingSearchResults instanceof CaseDetails) {
        caseFiles = existingSearchResults; // use search results "as is"
      } else
        if (Array.isArray(existingSearchResults)) {
          // When we get here via the browser back button, the CaseDetails collection that was in existingSearchResults has undergone
          // serialization (probably somewhere inside react-router) but unfortunately Backbone.toJSON() serializes the collection to
          // an array of plain objects where all non-model properties (like the very important property .isCriminal) have been discarded.
          // We must convert the array of plain objects back into a Backbone collection of CaseDetail models.
          //DEBUGONLY console.log('converting ',existingSearchResults);
          var isCriminal = (fileDivisionCd === 'criminal');
          caseFiles = new CaseDetails(existingSearchResults.map(elem => {
            var cd = new CaseDetail({}, { isCriminal: isCriminal });
            cd.set(cd.parse(elem));
            if (cd.detailType !== 1) { throw 'caseDetailTypeError'; }
            return cd;
          }));
        } else {
          throw 'existingSearchResultsError'; // unexpected object, we can't deal with it
        }

    var queryState = {
      selectedSearchMode: _.extend({}, searchMode, { value: query[searchMode.paramName] }),
      fileAgencyId: query.fileHomeAgencyId,
      fileDivisionCd: fileDivisionCd,
      courtClassCd: query.courtClassCd,
      filePrefix: query.filePrefixTxt,
      fileSequence: query.fileSuffixNo,
      fileTypeRef: query.mdocRefTypeCd,
      givenName: query.givenNm,
    };

    return _.defaults(
      {
        searching: false,
      },
      {
        pageHeader: currentUser.get('isMinistryUser') ? 'New Transcript Order' : 'New Transcript Order',
        formState: _.defaults({},
          this.props.location.state ? this.props.location.state.formState : null, // override with whatever is in the location.state (back button)
          queryState, // override again with whatever is in the querystring
          { // default to user's home location if not set
            fileAgencyId: currentUser.get('justinAgencyId'),
          }
        ),
      },
      _.pick(this.props.location.state, 'resultCount', 'showSearchResults', 'responseMessageTxt'),
      {
        resultCount: 0,
        showSearchResults: false,
        responseMessageTxt: null,
        searchResults: caseFiles,
        searchParams: query,
      }
    );
  },

  // Return true if the file division is set for a criminal search, false otherwise
  getCriminalFlag() {
    var fd = this.state.searchParams.fileDivisionCd; // set by FileSearchForm.jsx
    if (fd === undefined) { throw 'fileDivisionCdError'; }
    return fd === 'criminal';
  },

  componentDidMount() {
    var pageHeader = this.state.pageHeader;
    document.title = pageHeader;
  },

  onSearch(fetchPromise, queryParams, formState) {
    this.setState( // note that setState is async, so the setState callbacks is needed for well-defined sequencing
      { formState: formState, searching: true },
      () => {
        this.context.router.replace({ pathname: 'search', query: queryParams, state: this.state });
        fetchPromise.then(model => { // model is a CaseSearchResponse populated by its .fetch() and .parse() methods
          var resultCount = model.get('recCount');
          // model.get('caseFiles') contains the results of the search, a set of populated CaseDetail type 1 models.
          this.setState(
            {
              searchParams: queryParams,
              resultCount: resultCount,
              showSearchResults: true,
              searchResults: model.get('caseFiles'), // save results of the search in our state
              searching: false,
              responseMessageTxt: model.get('responseMessageTxt'),
            },
            () => {
              this.context.router.replace({
                pathname: 'search',
                query: queryParams,
                state: this.state, // WARNING: this.state.searchResults is a Backbone collection, and Backbone.toJSON() does not serialize non-attributes!
                searching: false,
              });
              if (resultCount === 1) {
                // Needs to be done in a `setTimeout` otherwise Bluebird throws a warning about creating a
                // promise inside a promise. This will happen becasue the router will change to showing the
                // new Case Information view in a synchronous manner.
                setTimeout(() => {
                  var firstCaseFile = model.get('caseFiles').first(); // a populated CaseDetail type 1 model
                  this.context.router.push({
                    pathname: `case-information/${firstCaseFile.get('caseId')}`, // .get('caseId') yields either a criminal mdocJustinNo or a civil physicalFileId
                    state: {
                      searchParams: this.state.searchParams, // searchParams.fileDivisionCd would have been set by FileSearchForm.jsx
                      sealStatusCd: firstCaseFile.get('sealStatusCd'),
                    },
                  });
                }, 0);
              } else if (resultCount > 1) {
                this.startScrollAnimation();
              }
            }//setState callback
          );
        }).catch(err => {
          this.setState({ searching: false });
          throw err;
        });
      }//setState callback
    );
  },

  onChangeCaseSearchProgress(fileDivisionCd) {
    const searchParams = _.extend(this.state.searchParams, {
      fileDivisionCd: fileDivisionCd,
    });
    this.setState({ searchParams: searchParams });
  },

  onEnterDetails(formState) {
    this.setState({
      duplicateFileNumber: null,
      searching: true,
      formState: formState,
    });

    var params = {
      pageNumber: 1,
      pageSize: 10,
      sortByField: 'orderDate:desc', // required for paging to work
      returnChildRecords: true,
      fileNumberTxt: formState.caseFileId,
    };

    var ordersPromise = api.get('transcripts/orders', params).then((orders) => {
      let fileNumbers = _.chain(orders).pluck('files').flatten().pluck('fileNumberTxt').map((fileNumberTxt) => { return fileNumberTxt.toLowerCase(); }).value();
      if (_.contains(fileNumbers, formState.caseFileId.toLowerCase())) {
        this.setState({
          duplicateFileNumber: formState.caseFileId,
        });
      }
    });

    Promise.all([ordersPromise, this.searchTMSForSpecialOrders(formState)]).finally(() => {
      this.setState({
        searching: false,
      });
      if (!this.state.duplicateFileNumber && !this.state.oldOrders) {
        this.redirectToRequestDetails(formState);
      }
    }, this);
  },

  searchTMSForSpecialOrders(formState) {
    this.setState({
      oldOrders: null,
    });
    var params = {
      fileNumberTxt: formState.caseFileId,
      courtLevelCd: 'P',
      startDate: _.first(formState.appearances).appearanceDt,
      endDate: _.last(formState.appearances).appearanceDt,
    };

    var tapemanCollection = new Tapeman();

    return tapemanCollection.fetch({ data: params }).then((oldOrders) => {
      _.each(formState.appearances, (appearance) => {
        var appearanceDate = appearance.appearanceDt;

        var possibleOldOrders = oldOrders.filter(oldOrder => {
          return oldOrder.get('dateOfProceedings').isSame(appearanceDate, 'day');
        });

        if (possibleOldOrders.length > 0) {
          this.setState({
            oldOrders: possibleOldOrders,
          });
        }
      }, this);
    }, this);
  },

  redirectToRequestDetails(formState) {
    this.context.router.push({
      pathname: 'request-details/',
      state: {
        selectedFiles: [
          {
            fileNumberTxt: formState.caseFileId,
            appearances: formState.appearances,
            courtDivisionCd: 'O',
            courtClassCd: 'S',
            courtLevelCd: 'P',
            fileHomeAgencyId: formState.fileHomeAgencyId,
            firstParticipantLastName: formState.accused,
          }],
        caseId: formState.caseFileId,
        searchParams: _.extend({}, this.state.searchParams, {
          fileDivisionCd: 'other',
        }),
      },
    });
  },

  cancelSpecialSubmit() {
    this.setState({
      duplicateFileNumber: null,
      oldOrders: null,
    });
  },

  searchWithDateRange(startDate, endDate) {
    var queryParams = _.extend({}, this.state.searchParams, {
      appearanceDateFilterStart: startDate.format('YYYY-MMM-DD'),
      appearanceDateFilterEnd: endDate.format('YYYY-MMM-DD'),
    });

    var searchPromise = new CaseSearchResponse({}, { isCriminal: this.getCriminalFlag() }).fetch({ data: queryParams });

    this.onSearch(searchPromise, queryParams, this.state.formState);
  },

  startScrollAnimation() {
    var page = $('html, body');

    function stopScrollingFn() {
      page.stop();
    }

    page.on('scroll wheel DOMMouseScroll mousewheel mousedown keydown touchmove', stopScrollingFn);

    page.animate({ scrollTop: $('#search-results').position().top - 60 }, 'slow', () => {
      page.off('scroll wheel DOMMouseScroll mousewheel mousedown keydown touchmove', stopScrollingFn);
    });
  },

  render() {
    return <div id="case-search">
      <PageHeader>{this.state.pageHeader}</PageHeader>
      <CaseSearchProgress searchProgress={this.state.searchProgress} searchParams={this.state.searchParams} />
      <Panel header="Search Criteria">
        <FileSearchForm formState={this.state.formState} onSearch={this.onSearch} onChangeCaseSearchProgress={this.onChangeCaseSearchProgress} onEnterDetails={this.onEnterDetails} fileDivisionLocked={false} />
      </Panel>
      {this.state.searching && !this.state.showSearchResults ? <Spinner centre /> : null}
      {(() => {
        if (this.state.duplicateFileNumber || this.state.oldOrders) {
          return <Alert bsStyle="warning">This audio is either currently being transcribed or has
          previously been transcribed. Please ensure that this is a
          not a duplicate transcription request. Do you wish to proceed with this order?
          {
            this.state.oldOrders ?
              <Row>
                <Col md={4} className="old-orders-for-day">
                  <h3 style={{ textAlign: 'right' }}>Legacy Orders</h3>
                  <ol>
                    {
                      this.state.oldOrders.map(oldOrder => {
                        return <li key={oldOrder.get('transcriptId')} className="old-order">
                          <h5>
                            <span className="date pull-right">{Moment(oldOrder.orderDate).format('DD-MMM-YYYY')}</span>
                            Order {oldOrder.get('transcriptId')}
                          </h5>
                          <div className="cancelled">
                            Cancelled: {oldOrder.cancelled ? 'Yes' : 'No'}
                          </div>
                          {oldOrder.get('actionNumber') ? <div>File: {oldOrder.get('actionNumber')}</div> : null}
                          {oldOrder.get('courtLevel') ? <div>Court Level: {oldOrder.get('courtLevel')}</div> : null}
                          {oldOrder.get('courtType') ? <div>Court Type: {oldOrder.get('courtType')}</div> : null}
                          {oldOrder.get('courtroom') ? <div>Court Room: {oldOrder.get('courtroom')}</div> : null}
                          {oldOrder.get('descriptionOfOrder') ? <div>Description: {oldOrder.get('descriptionOfOrder')}</div> : null}
                          {oldOrder.get('descriptionOfOrderTranscribed') ? <div>Description Transcribed: {oldOrder.get('descriptionOfOrderTranscribed')}</div> : null}
                          {oldOrder.get('justice') ? <div>Justice: {oldOrder.get('justice')}</div> : null}
                          {oldOrder.get('orderType') ? <div>Order Type: {oldOrder.get('orderType')}</div> : null}
                          {oldOrder.get('registry') ? <div>Registry: {oldOrder.get('registry')}</div> : null}
                          {oldOrder.get('styleOfCause') ? <div>Style Of Cause: {oldOrder.get('styleOfCause')}</div> : null}
                          {oldOrder.get('dateSentToTranscriber') ? <div>Sent To Transcriber on: {oldOrder.get('dateSentToTranscriber').format('DD-MMM-YYYY')}</div> : null}
                          {oldOrder.get('dateSentToJudge') ? <div>Sent to Judge on: {oldOrder.get('dateSentToJudge').format('DD-MMM-YYYY')}</div> : null}
                          {oldOrder.get('dateTranscriptReceived') ? <div>Transcript Received on: {oldOrder.get('dateTranscriptReceived').format('DD-MMM-YYYY')}</div> : null}
                        </li>;
                      })
                    }
                  </ol>
                </Col>
              </Row> : null
            }
            <Button bsStyle="primary" style={{ margin: 10 }} onClick={() => this.redirectToRequestDetails(this.state.formState)}>Yes</Button>
            <Button onClick={this.cancelSpecialSubmit}>No</Button>
          </Alert>;
        }
        if (this.state.showSearchResults) {
          if (this.state.resultCount === 0) {
            //  If the search returned no results then display a warning.
            return <Alert bsStyle="warning">No cases matching the filter criteria were found. Please check to ensure the search criteria is correct. If you are sure you have the correct search criteria, and you don't get the results you expect, please contact the registry.</Alert>;
          } else if (this.state.resultCount > 0) {
            var warning;
            if (this.state.responseMessageTxt) {
              warning = <Alert bsStyle="warning">{this.state.responseMessageTxt}</Alert>;
            }
            return <div>
              {warning}
              <CaseSearchResultList resultCount={this.state.resultCount} searchResults={this.state.searchResults} searchParams={this.state.searchParams} searching={this.state.searching} onSearch={this.searchWithDateRange} />
            </div>;
          } else {
            return <Alert bsStyle="danger">{this.state.responseMessageTxt}</Alert>;
          }
        }
      })()}
    </div>;
  },
});


var CaseSearchResultList = React.createBackboneClass({
  changeOptions: 'change',

  propTypes: {
    resultCount: React.PropTypes.number,
    searchResults: React.PropTypes.object, // a collection of CaseDetail type 1
    searchParams: React.PropTypes.object,
    searching: React.PropTypes.bool,
    onSearch: React.PropTypes.func,
  },

  contextTypes: {
    router: React.PropTypes.object.isRequired,
  },

  getInitialState() {
    var startDate = Moment();
    if (this.props.searchParams.appearanceDateFilterStart) {
      startDate = Moment(this.props.searchParams.appearanceDateFilterStart, 'YYYY-MMM-DD');

    }

    var endDate = Moment().add(4, 'd');
    if (this.props.searchParams.appearanceDateFilterEnd) {
      endDate = Moment(this.props.searchParams.appearanceDateFilterEnd, 'YYYY-MMM-DD');
    }

    if (this.props.searchParams.appearanceDateFilterStart && !this.props.searchParams.appearanceDateFilterEnd) {
      endDate = Moment(startDate).add(4, 'M');
    }

    return {
      startDate,
      endDate,
    };
  },

  getCriminalFlag() {
    var fd = this.props.searchParams.fileDivisionCd;
    if (fd === undefined) { throw 'fileDivisionCdError'; }
    return fd === 'criminal';
  },

  handleStartDateChange(startDt/*, event*/) {
    /* Unfortunately, the datetimepicker component does not return null when the date is cleared from the input.
     * Instead it returns a "moment" parsed date where blank results in the string "Invalid date".
     */
    this.setState({ startDate: Moment(+startDt) });
  },

  handleEndDateChange(endDt/*, event*/) {
    /* Unfortunately, the datetimepicker component does not return null when the date is cleared from the input.
     * Instead it returns a "moment" parsed date where blank results in the string "Invalid date".
     */
    this.setState({ endDate: Moment(+endDt) });
  },

  handleSearch() {
    this.props.onSearch(this.state.startDate, this.state.endDate);
  },

  render() {
    // If the search returned results then display the results.
    var isCriminal = this.getCriminalFlag();
    return <div id="search-results">
      <Panel bsStyle="primary">
        <div id="search-dates" className="clearfix pull-right">
          <small id="search-dates-label">Date</small>

          <div id="search-start-date" className="search-date">
            <label>Start Date</label>
            <DateTimePicker inputFormat="DD-MMM-YYYY" mode="date" defaultText={this.props.searchParams.appearanceDateFilterStart ? Moment(this.state.startDate).format('DD-MMM-YYYY') : ''} dateTime={this.state.startDate + ''} inputProps={{ placeholder: 'DD-MMM-YYYY' }} onChange={this.handleStartDateChange} />
          </div>
          <div id="search-end-date" className="search-date">
            <label>End Date</label>
            <DateTimePicker inputFormat="DD-MMM-YYYY" mode="date" defaultText={this.props.searchParams.appearanceDateFilterEnd ? Moment(this.state.endDate).format('DD-MMM-YYYY') : ''} dateTime={this.state.endDate + ''} inputProps={{ placeholder: 'DD-MMM-YYYY' }} onChange={this.handleEndDateChange} />
          </div>
          <Button bsStyle="primary" disabled={this.props.searching} onClick={this.handleSearch}>
            Search
            <Spinner show={this.props.searching} />
          </Button>
        </div>

        <h3>Found <strong>{this.props.resultCount}</strong> Similar Cases</h3>
        <br />
        <small>Choose below or refine your search</small>
        <Table striped>
          <thead>
            <tr>
              <th>File Number</th>
              <th>{isCriminal ? <span>Accused</span> : <span>Party</span>}</th>
              <th>Location</th>
              <th>Level</th>
              <th>Classification</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {
              this.props.searchResults.map((caseDetail) => { // model object CaseDetail type 1
                return <CaseSearchResultList.CaseListInformation key={caseDetail.getCaseId()} caseInfo={caseDetail} {...this.props} />;
              })
            }
          </tbody>
        </Table>
      </Panel>
    </div>;
  },
});

CaseSearchResultList.CaseListInformation = React.createClass({
  propTypes: {
    caseInfo: React.PropTypes.object,
    searchParams: React.PropTypes.object,
  },

  contextTypes: {
    router: React.PropTypes.object.isRequired,
  },

  viewFileClick(/*event*/) {
    var caseInfo = this.props.caseInfo; // model object: CaseDetail type 1
    var key = caseInfo.getCaseId();

    // The history object is included from the react-router component for navigation.
    this.context.router.push({
      pathname: `case-information/${key}`,
      state: {
        searchParams: this.props.searchParams,
        sealStatusCd: caseInfo.get('sealStatusCd'),
      },
    });
  },

  render() {
    var caseInfo = this.props.caseInfo; // model object: CaseDetail type 1
    if (caseInfo.isCriminal === undefined) { throw 'isCriminalError'; }

    return <tr>
      <td className="nowrap">
        {caseInfo.get('displayFileNumber')}
        {caseInfo.get('sealStatusCd') === 'SD' ? <span className='sealhighlight'><br />(sealed)</span> : ''}
      </td>
      <td>
        {
          _.pluck(caseInfo.get('participant'), 'fullNm').join('; ')
        }
      </td>
      <td className="nowrap">{CodeLookups.getCodeTableAttribute('locations', caseInfo.get('fileHomeAgencyId'), 'longDesc')}</td>
      <td>{CodeLookups.getDesc('levels', caseInfo.get('courtLevelCd'))}</td>
      <td>{CodeLookups.getDesc('classes', caseInfo.get('courtClassCd'))}</td>
      <td><Button bsStyle="primary" onClick={this.viewFileClick}>View</Button></td>
    </tr>;
  },
});

export default CaseSearch;
