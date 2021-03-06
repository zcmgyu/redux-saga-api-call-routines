import _ from 'lodash';
import invariant from 'fbjs/lib/invariant';
import { call, put, race, select, take, takeEvery } from 'redux-saga/effects';
import { cancelAll } from './ApiCallActions';

const opts = {
  predicate: (action) => {
    return action && _.endsWith(action.type, 'REQUEST') && action.payload;
  },
  authPredicate: (payload) => payload.auth,
  cancelPredicate: (action) => {
    const cancelActionType = _.replace(action, 'REQUEST', 'CANCEL');
    return (cancelAction) => {
      return cancelAction.type === `${cancelAll}` || cancelAction.type === cancelActionType;
    }
  },
  response: (action, payload) => ({
  type: _.replace(action.type, 'REQUEST', 'RESPONSE'),
  payload
}),
  error: (action, payload) => ({
  type: _.replace(action.type, 'REQUEST', 'ERROR'),
  payload
})
};

class ApiCallCancelled extends Error {
  message = "Cancelled";
}


//TODO: make it a class?
function *apiCall({ fetchApi, refreshAccessToken },
                  { logout, tokenRefreshing, tokenRefreshed },
                  { isTokenRefreshing, selectAccessToken, selectRefreshToken },
                  authPredicate, cancelPredicate, action) {

  const { type, payload } = action;

  /*** any error means error ***/
  try {

    let exit = false;

    /*** this loop is to be able to retry the request in case ***/
    while (true) {
      let selectedToken;

      /*** if requires auth then wait if token is refreshing or cancel ***/
      if(authPredicate(payload)) {
        if (yield select(isTokenRefreshing)) {

          const {cancelled} = yield race({
            refreshed: take(`${tokenRefreshed}`),
            cancelled: take(cancelPredicate(action))
          });

          if (cancelled) {
            throw new ApiCallCancelled();
          }
        }

        selectedToken = yield select(selectAccessToken);
      }

      console.log(selectedToken);

      //TODO: validate token
      /*** if token is invalid, try to refresh it and start over ***/
      if(false) { //TOKEN INVALID
        yield* refreshToken({ selectRefreshToken, refreshAccessToken, tokenRefreshing, tokenRefreshed, logout, cancelPredicate });
        exit = true;
        continue;
      }

      const {response, cancelled} = yield race({
        response: call(fetchApi, payload, selectedToken),
        cancelled: take(cancelPredicate(action))
      });

      if (cancelled) {
        throw new ApiCallCancelled();
      }

      if (response.ok) {
        yield put(opts.response(action, response));
        return;
      }

      console.log(response, !exit && authPredicate(payload) && response.status === 403); //TODO: rejected accessToken predicate

      if(!exit && authPredicate(payload) && response.status === 403) {
        yield* refreshToken({ action, selectRefreshToken, refreshAccessToken, tokenRefreshing, tokenRefreshed, logout, cancelPredicate });
        exit = true;
      } else {
        //TODO: define response based errors
        //TODO: test this part
        yield put(opts.error(action, response));
        return;
      }
    }
  } catch (e) {
    yield put(opts.error(action, e));
  }
}

function* refreshToken({ action, selectRefreshToken, refreshAccessToken, tokenRefreshing, tokenRefreshed, logout, cancelPredicate }) {
  const refreshToken = yield select(selectRefreshToken);
  if(!refreshToken) {
    yield put(logout());
    throw new ApiCallCancelled();
  }

  yield put(tokenRefreshing());

  const { refreshedToken, cancelled } = yield race({
    refreshedToken: call(refreshAccessToken, refreshToken),
    cancelled: take(cancelPredicate(action))
  });

  if(cancelled) {
    throw new ApiCallCancelled();
  }

  invariant(_.isString(refreshToken), "refreshToken should return a String, null or throw error");

  if(refreshedToken) {
    yield put(tokenRefreshed({ accessToken: refreshedToken }));
    return true;
  } else {
    yield put(logout());
  }
}

export default function *ApiCallSagas({
                                        fetchApi,
                                        refreshAccessToken,
                                        logout,
                                        tokenRefreshing,
                                        tokenRefreshed,
                                        isTokenRefreshing,
                                        selectAccessToken,
                                        selectRefreshToken
                                      } = {},
                                      pattern = opts.predicate,
                                      authPredicate = opts.authPredicate,
                                      cancelPredicate = opts.cancelPredicate
) {

  invariant(fetchApi, "fetchApi method must be defined within the argument passed to ApiCallSagas");
  invariant(refreshAccessToken, "refreshAccessToken method must be defined within the argument passed to ApiCallSagas");
  invariant(logout, "logout action must be defined within the argument passed to ApiCallSagas");
  invariant(tokenRefreshing, "tokenRefreshing action must be defined within the argument passed to ApiCallSagas");
  invariant(tokenRefreshed, "tokenRefreshed action must be defined within the argument passed to ApiCallSagas");
  invariant(isTokenRefreshing, "isTokenRefreshing selector must be defined within the argument passed to ApiCallSagas");
  invariant(selectAccessToken, "selectAccessToken selector must be defined within the argument passed to ApiCallSagas");
  invariant(selectRefreshToken, "selectRefreshToken selector must be defined within the argument passed to ApiCallSagas");

  yield takeEvery(pattern, apiCall,
    { fetchApi, refreshAccessToken },
    { logout, tokenRefreshing, tokenRefreshed },
    { isTokenRefreshing, selectAccessToken, selectRefreshToken },
    authPredicate, cancelPredicate);
}

export function* ApiCall(Routine, options) {
  /*** trigger request action, so that it can be taken by ApiSaga ***/
  yield put(Routine.request(options));

  /*** yield the winner ***/
  const { response, error } = yield race({
    response: take(Routine.RESPONSE),
    error: take(Routine.ERROR)
  });

  if(response) {
    return { response: response.payload };
  }
  return { error: error.payload };
};