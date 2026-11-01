/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Shown in place of the password form when gateway sign-in is enabled. The
// sign-in itself starts from the login saga as soon as the page loads; this
// component reports its progress, any refusal, and the terms or TOTP steps.

import React, { useCallback, useMemo } from 'react';
import classNames from 'classnames';
import { useSelector } from 'react-redux';
import { useTranslation, Trans } from 'react-i18next';
import { Button, Grid, Header, Loader, Message } from 'semantic-ui-react';

import selectors from '../../../selectors';
import AccessTokenSteps from '../../../constants/AccessTokenSteps';
import TermsModal from './TermsModal';
import TotpChallengeModal from './TotpChallengeModal';

import logo from '../../../assets/images/logo.png';

import styles from './Content.module.scss';

// English defaults; a translation can override each key in the locale files.
const MESSAGES = {
  signingIn: ['gateway.signingIn', 'Planka is signing you in.'],
  notPermitted: [
    'gateway.notPermitted',
    'Your account does not have access to Planka. If you need access, you can contact the Planka administrator for assistance.',
  ],
  deactivated: [
    'gateway.deactivated',
    'Your Planka account has been deactivated. If you believe this is a mistake, you can contact the Planka administrator for assistance.',
  ],
  noIdentity: [
    'gateway.noIdentity',
    'Planka has not been able to confirm who you are. Sign in again, and if the problem continues, you can contact the Planka administrator for assistance.',
  ],
  notSignedIn: ['gateway.notSignedIn', 'Planka has not signed you in.'],
  connectionFailed: [
    'gateway.connectionFailed',
    'Planka has not been able to reach the server. Check your connection, then sign in again.',
  ],
  unknownError: [
    'gateway.unknownError',
    'Planka has not been able to sign you in. If the problem continues, you can contact the Planka administrator for assistance.',
  ],
  signInAgain: ['gateway.signInAgain', 'Sign in again'],
};

const messageForError = (error) => {
  if (!error) {
    return null;
  }

  switch (error.message) {
    case 'Not permitted to use PLANKA':
      return MESSAGES.notPermitted;
    case 'User is deactivated':
      return MESSAGES.deactivated;
    case 'No gateway identity':
      return MESSAGES.noIdentity;
    case 'Failed to fetch':
    case 'Network request failed':
      return MESSAGES.connectionFailed;
    default:
      return MESSAGES.unknownError;
  }
};

const GatewayContent = React.memo(() => {
  const bootstrap = useSelector(selectors.selectBootstrap);
  const { isSubmitting, error, step } = useSelector(selectors.selectAuthenticateForm);

  const [t] = useTranslation();

  const errorMessage = useMemo(() => messageForError(error), [error]);

  // A fresh page load passes through the gateway again and starts a new sign-in.
  const handleSignInAgain = useCallback(() => {
    window.location.reload();
  }, []);

  let body;
  if (isSubmitting) {
    body = (
      <>
        <Loader active inline="centered" />
        <p>{t(...MESSAGES.signingIn)}</p>
      </>
    );
  } else if (!step) {
    body = (
      <>
        <Message
          {...(errorMessage ? { error: true } : { info: true })}
          visible
          content={t(...(errorMessage || MESSAGES.notSignedIn))}
        />
        <Button fluid primary content={t(...MESSAGES.signInAgain)} onClick={handleSignInAgain} />
      </>
    );
  }

  return (
    <div className={classNames(styles.wrapper, styles.fullHeight)}>
      <Grid verticalAlign="middle" className={styles.grid}>
        <Grid.Column computer={6} tablet={16} mobile={16} className={styles.gridItem}>
          <div className={styles.login}>
            <div className={styles.form}>
              <div className={styles.logoWrapper}>
                <img src={logo} alt="" className={styles.logo} />
              </div>
              <Header
                as="h1"
                textAlign="center"
                content={bootstrap.instanceName || 'PLANKA'}
                className={styles.formTitle}
              />
              {body}
            </div>
            <div className={styles.poweredBy}>
              <p className={styles.poweredByText}>
                <Trans i18nKey="common.poweredByPlanka">
                  {'Powered by '}
                  <a href="https://github.com/plankanban/planka" target="_blank" rel="noreferrer">
                    PLANKA
                  </a>
                </Trans>
              </p>
            </div>
          </div>
        </Grid.Column>
        <Grid.Column
          computer={10}
          only="computer"
          className={classNames(styles.gridItem, styles.cover)}
        >
          <div className={styles.coverOverlay} />
        </Grid.Column>
      </Grid>
      {step === AccessTokenSteps.ACCEPT_TERMS && <TermsModal />}
      {step === AccessTokenSteps.VERIFY_TOTP && <TotpChallengeModal />}
    </div>
  );
});

export default GatewayContent;
