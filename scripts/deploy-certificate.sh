#!/usr/bin/env bash
# Creates the TLS certificate for the custom domain (infra/certificate.yaml)
# in us-east-1, the only region CloudFront accepts certificates from.
# Every AWS command is printed before it runs.
#
# Usage:
#   AWS_PROFILE=<profile> DOMAIN_NAME=workout.example.com ./scripts/deploy-certificate.sh
# Optional: HOSTED_ZONE_ID (only if the domain's DNS is in Route 53),
#           CERT_STACK_NAME (default workout-tracker-certificate)
#
# When DNS is not in Route 53, this prints a CNAME to add at your DNS provider
# and waits until ACM sees it (usually a few minutes after you add it).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DOMAIN_NAME:?Set DOMAIN_NAME, e.g. DOMAIN_NAME=workout.example.com}"
CERT_STACK_NAME="${CERT_STACK_NAME:-workout-tracker-certificate}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
CERT_REGION=us-east-1

run() { printf '+ %s\n' "$*"; "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "1/4 Validate template"
run aws cloudformation validate-template --region "$CERT_REGION" \
  --template-body file://infra/certificate.yaml --query Description --output text

if aws cloudformation describe-stacks --region "$CERT_REGION" --stack-name "$CERT_STACK_NAME" >/dev/null 2>&1; then
  step "2/4 Stack exists; nothing to create"
else
  step "2/4 Create certificate stack in $CERT_REGION (requests the certificate)"
  run aws cloudformation create-stack --region "$CERT_REGION" \
    --stack-name "$CERT_STACK_NAME" \
    --template-body file://infra/certificate.yaml \
    --parameters "ParameterKey=DomainName,ParameterValue=$DOMAIN_NAME" \
                 "ParameterKey=HostedZoneId,ParameterValue=$HOSTED_ZONE_ID" \
    --query StackId --output text

  step "3/4 DNS validation record"
  echo "+ aws cloudformation describe-stack-resource / aws acm describe-certificate (polling)"
  CERT_ARN=""
  for _ in $(seq 1 60); do
    CERT_ARN="$(aws cloudformation describe-stack-resource --region "$CERT_REGION" --stack-name "$CERT_STACK_NAME" \
      --logical-resource-id Certificate --query StackResourceDetail.PhysicalResourceId --output text 2>/dev/null || true)"
    if [[ "$CERT_ARN" == arn:* ]]; then
      RECORD="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
        --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text 2>/dev/null || true)"
      if [[ -n "$RECORD" && "$RECORD" != "None" ]]; then break; fi
    fi
    sleep 5
  done
  if [[ -z "$HOSTED_ZONE_ID" ]]; then
    read -r REC_NAME REC_VALUE <<<"$RECORD"
    cat <<EOF

  Add this record at your DNS provider now (Cloudflare: Proxy status = DNS only):
    Type:   CNAME
    Name:   $REC_NAME
    Target: $REC_VALUE
  Leave it in place afterwards: ACM uses it to renew the certificate automatically.

EOF
  else
    echo "Route 53 zone given: CloudFormation adds the validation record itself."
  fi

  step "4/4 Wait for the certificate to be issued"
  run aws cloudformation wait stack-create-complete --region "$CERT_REGION" --stack-name "$CERT_STACK_NAME"
fi

CERT_ARN="$(aws cloudformation describe-stacks --region "$CERT_REGION" --stack-name "$CERT_STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue" --output text)"
printf '\nCertificate ready. Next:\n  CERTIFICATE_ARN=%s\n' "$CERT_ARN"
