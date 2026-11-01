/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

import React from 'react';
import { useSelector } from 'react-redux';
import { Loader } from 'semantic-ui-react';

import selectors from '../../../selectors';
import Content from './Content';
import GatewayContent from './GatewayContent';

const Login = React.memo(() => {
  const isInitializing = useSelector(selectors.selectIsInitializing);
  const bootstrap = useSelector(selectors.selectBootstrap);

  if (isInitializing) {
    return <Loader active size="massive" />;
  }

  // Gateway sign-in (local modification, see GATEWAY.md).
  return bootstrap && bootstrap.gateway ? <GatewayContent /> : <Content />;
});

export default Login;
