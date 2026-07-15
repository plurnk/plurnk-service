# Budget as dynamic mermaid — sketches (run1 real data)

Exploration of new mermaid formats for the `Budget` section. `treemap`/`xychart` are recent
mermaid types; whether GitHub renders them is the open question these sketches answer.

## Heaviest items → treemap (the eviction map)

Biggest box = the thing to FOLD/KILL. Aimed at the budget-overflow recovery rail.

```mermaid
treemap-beta
"Heaviest log items — tokens"
    "READ 1/1/5": 731
    "PLAN 1/7/1": 145
    "PLAN 1/6/1": 112
    "PLAN 1/5/1": 106
    "PLAN 1/2/1": 66
    "EXEC 1/6/2": 61
    "SEND 1/6/3": 52
    "PLAN 1/4/1": 52
    "PLAN 1/3/1": 48
    "PLAN 1/1/4": 47
```

### Richer variant — grouped by op (two levels of insight)

```mermaid
treemap-beta
"Budget by op"
    "READ"
        "1/1/5": 731
    "PLAN"
        "1/7/1": 145
        "1/6/1": 112
        "1/5/1": 106
        "1/2/1": 66
        "1/4/1": 52
        "1/3/1": 48
        "1/1/4": 47
    "EXEC"
        "1/6/2": 61
    "SEND"
        "1/6/3": 52
```

## Per-turn spend → xychart (velocity / spikes)

```mermaid
xychart-beta
    title "Tokens per turn"
    x-axis [t1, t2, t3, t4, t5, t6, t7]
    y-axis "tokens" 0 --> 900
    bar [898, 145, 154, 116, 174, 225, 215]
```

## The gauge — deliberately NOT a diagram

`Token Ceiling 97280 · Token Usage 33109 (34%) · Tokens Free 64171` — a line wins. A pie of
used/free is decoration for a value already clear as a percentage.
