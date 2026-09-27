```EDIT (django/utils/functional.py) <@4ezVW,@aqBqa>
        return "<%s: %r>" % (type(self).__name__, repr_attr)

    def __radd__(self, other):
        if self._wrapped is empty:
            self._setup()
        return other + self._wrapped

```EDIT (tests/utils_tests/test_simplelazyobject.py) <@z9Hgf,-1>

    def test_radd(self):
        x = SimpleLazyObject(lambda: 5)
        self.assertEqual(6, 1 + x)
```

Now verify with the existing and new tests:```sh
cd /workspace 2>/dev/null || cd "$(git rev-parse --show-toplevel)"; python -m pytest tests/utils_tests/test_simplelazyobject.py tests/utils_tests/test_lazyobject.py -q 2>&1 | tail -5
```