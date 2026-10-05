import pytest

from nightshift_eval.validate import Verdict, classify


@pytest.mark.parametrize(
    ("without_gold", "with_gold", "verdict"),
    [
        ([0, 0, 0], [1, 1, 1], Verdict.VALID),
        ([1, 1, 1], [1, 1, 1], Verdict.ALREADY_PASSING),
        ([0, 0, 0], [0, 0, 0], Verdict.STILL_FAILING),
        ([0, 1, 0], [1, 1, 1], Verdict.FLAKY),
        ([0, 0, 0], [1, 0, 1], Verdict.FLAKY),
        ([1, 1, 1], [0, 0, 0], Verdict.INVERTED),
    ],
)
def test_classify(without_gold, with_gold, verdict):
    assert classify(without_gold, with_gold) is verdict


def test_classify_requires_runs():
    with pytest.raises(ValueError):
        classify([], [1])
