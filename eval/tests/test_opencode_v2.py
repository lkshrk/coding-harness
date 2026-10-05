import subprocess

import pytest

from nightshift_eval.opencode_v2 import (
    CA_PATH,
    RELEASES,
    container_env,
    install_command,
    run_command,
    trust_ca_command,
)


def _parses(script: str, tmp_path) -> bool:
    path = tmp_path / "s.sh"
    path.write_text(script)
    return subprocess.run(["bash", "-n", str(path)], capture_output=True).returncode == 0


def test_install_pins_one_checksummed_tarball_per_arch():
    assert set(RELEASES) == {"x86_64", "aarch64"}
    for url, sha in RELEASES.values():
        assert url.startswith("https://opencode.ai/files/bin/2.")
        assert len(sha) == 64


def test_install_verifies_checksum_before_installing(tmp_path):
    cmd = install_command()
    assert _parses(cmd, tmp_path)
    assert cmd.index("sha256sum -c") < cmd.index("install -m 755")
    for url, sha in RELEASES.values():
        assert url in cmd
        assert sha in cmd


def test_trust_ca_writes_pem_verbatim(tmp_path):
    pem = "-----BEGIN CERTIFICATE-----\nMIIB'x$y\n-----END CERTIFICATE-----\n"
    target = tmp_path / "ca.crt"
    cmd = trust_ca_command(pem, path=str(target), refresh="true")
    assert _parses(cmd, tmp_path)
    subprocess.run(["bash", "-c", cmd], check=True)
    assert target.read_text() == pem


def test_trust_ca_refreshes_system_store_by_default():
    assert trust_ca_command("x").endswith("update-ca-certificates")


def test_run_uses_v2_flags_and_closes_stdin(tmp_path):
    cmd = run_command("litellm/anthropic/claude-opus-5-5", "fix it; don't 'break' $HOME")
    assert _parses(cmd, tmp_path)
    assert "--standalone" in cmd
    assert "--dangerously-skip-permissions" not in cmd
    assert "</dev/null" in cmd
    assert "--format=json" in cmd
    assert cmd.startswith("opencode run --model=litellm/anthropic/claude-opus-5-5 ")


@pytest.mark.parametrize("model", ["", "no-provider"])
def test_run_rejects_model_without_provider(model):
    with pytest.raises(ValueError):
        run_command(model, "x")


def test_container_env_passes_only_the_gateway_key_from_host():
    env = container_env({"A": "1"}, {"LITELLM_API_KEY": "k", "HOME": "/h", "AWS_SECRET": "s"}, ca=True)
    assert env["LITELLM_API_KEY"] == "k"
    assert env["A"] == "1"
    assert env["NODE_EXTRA_CA_CERTS"] == CA_PATH
    assert "HOME" not in env and "AWS_SECRET" not in env


def test_container_env_without_ca_or_key():
    env = container_env({}, {}, ca=False)
    assert "NODE_EXTRA_CA_CERTS" not in env and "LITELLM_API_KEY" not in env
