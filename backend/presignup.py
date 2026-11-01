"""Cognito Pre sign-up trigger: only people with the crew invite code can
create an account.

The code arrives as ValidationData (or ClientMetadata) "inviteCode" from the
landing page's invite form. The expected value comes from the INVITE_CODE
environment variable, set from the NoEcho CloudFormation parameter, so it is
never in source. Accounts created by an admin (aws cognito-idp
admin-create-user) don't need a code.
"""

import hmac
import os

REJECTED = "That invite code didn't work. Check it with Courtney and try again."


def lambda_handler(event, context):
    if event.get("triggerSource") == "PreSignUp_AdminCreateUser":
        return event
    request = event.get("request") or {}
    code = ((request.get("validationData") or {}).get("inviteCode")
            or (request.get("clientMetadata") or {}).get("inviteCode") or "")
    expected = os.environ.get("INVITE_CODE", "")
    # constant-time comparison; an unset code rejects everyone
    if not expected or not isinstance(code, str) or not hmac.compare_digest(code.strip().encode(), expected.encode()):
        raise Exception(REJECTED)
    return event
