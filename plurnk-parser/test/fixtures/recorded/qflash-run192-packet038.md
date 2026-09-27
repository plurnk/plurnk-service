```KILL
## Summary

Fixed the issue where `Axis.set_ticks` (and by extension `Axes.set_xticks`/`Axes.set_yticks`) silently ignored `**kwargs` when `labels` was not provided.

### Change

**`lib/matplotlib/axis.py`** — `Axis.set_ticks` method (line ~2027):

```python
    def set_ticks(self, ticks, labels=None, *, minor=False, **kwargs):
        result = self._set_tick_locations(ticks, minor=minor)
        if labels is not None:
            self.set_ticklabels(labels, minor=minor, **kwargs)
        elif kwargs:
            raise ValueError(
                "Passing additional keyword arguments to set_ticks() is "
                "only effective when labels are also provided. "
                "Use tick_params() to set text properties on tick labels.")
        return result
```

### Behavior

| Call | Before | After |
|------|--------|-------|
| `ax.set_xticks([0,1], xticklabels=["a","b"])` | Silently ignored | `ValueError` raised |
| `ax.set_xticks([0,1], color="red")` | Silently ignored | `ValueError` raised |
| `ax.set_xticks([0,1], ["a","b"], fontweight="bold")` | Works | Works (unchanged) |
| `ax.set_xticks([0,1])` | Works | Works (unchanged) |

### Verification

- All tick-related tests in `test_axes.py` (59 passed) and `test_colorbar.py` (9 passed) succeed.
- Manual integration test confirms the error message and correct pass-through behavior.