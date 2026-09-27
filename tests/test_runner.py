from coding_harness.runner import VERDICT


def test_verdict_parsing():
    assert VERDICT.search("findings...\nVERDICT: PASS").group(1) == "PASS"
    assert VERDICT.search("verdict: fail").group(1).upper() == "FAIL"
    assert VERDICT.search("no verdict here") is None
