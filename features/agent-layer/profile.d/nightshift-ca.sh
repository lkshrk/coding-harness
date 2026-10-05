# shellcheck shell=sh
if nightshift_ca_env="$(nightshift-ca-env 2>/dev/null)"; then
  eval "$nightshift_ca_env"
fi
unset nightshift_ca_env
