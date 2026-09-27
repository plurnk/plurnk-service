Looking at the bug, line 828 in `_print_MatAdd` does `S(item.args[0]).is_negative`, which tries to sympify `item.args[0]`. When `item` is a `MatrixSymbol`, `args[0]` is a plain Python string (the symbol name), which fails to parse.

The fix: only check for negativity when the item is a `MatMul` with a numeric coefficient as its first argument.

```EDIT (sympy/printing/pretty/pretty.py) <@Pplaq>
                if item.is_MatMul and item.args[0].is_Number and item.args[0].is_negative:
```

Now let me verify the fix works:

```WORK (worker://verify)
Run this test in the sympy repository to verify the MatAdd pretty printing fix works:

```sh
cd /home/user/repos/sympy && python3 -c "
from sympy import MatrixSymbol, pprint, n
n = 3
x = MatrixSymbol('x', n, n)
y = MatrixSymbol('y*', n, n)

# Test case from the issue: should not crash
pprint(x + y)
print('---')

# Test with negative coefficients
pprint(-2*x + y)
print('---')

# Multiple terms
pprint(-2*x + 3*y - x)
print('---')

# Ensure existing tests pass
import subprocess
result = subprocess.run(['python3', '-m', 'pytest', 'sympy/printing/tests/test_pretty.py', '-x', '-q'], capture_output=True, text=True)
print(result.stdout[-500:] if len(result.stdout) > 500 else result.stdout)
print(result.stderr[-500:] if len(result.stderr) > 500 else result.stderr)
"
```