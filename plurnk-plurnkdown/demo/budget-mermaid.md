# Budget as dynamic mermaid — budget-scaled (run1 real data)

Both scaled to the **full budget** (ceiling 44236), not relative to the items. The point:
**salience tracks pressure** — near-empty and calm at low usage (here, 11%), filling toward
urgent as the ceiling nears. The real test is a *high-usage* run, where the turns must fill
the treemap and the bars must climb. This low example should read sparse — that's correct.

## Turn size → treemap (budget composition)

Turn boxes + `free` = the whole ceiling. At 11% usage, `free` dominates by design.

```mermaid
treemap-beta
"Budget — ceiling 44236"
    "free": 39553
    "system + context": 2756
    "turn 1/1": 898
    "turn 1/2": 145
    "turn 1/3": 154
    "turn 1/4": 116
    "turn 1/5": 174
    "turn 1/6": 225
    "turn 1/7": 215
```

## Top-ten items → xychart (bars against the full ceiling)

The empty space above the bars **is** the headroom.

```mermaid
xychart-beta
    title "Heaviest items vs 44236 ceiling"
    x-axis ["1/1/5", "1/7/1", "1/6/1", "1/5/1", "1/2/1", "1/6/2", "1/6/3", "1/4/1", "1/3/1", "1/1/4"]
    y-axis "tokens" 0 --> 44236
    bar [731, 145, 112, 106, 66, 61, 52, 52, 48, 47]
```

## Gauge → pie (used vs free)

Inherently budget-scaled — used + free = the whole ceiling. As much a training exemplar for
the model's own user-facing SENDs as it is a meter.

```mermaid
pie showData
    title Budget — used vs free (ceiling 44236)
    "used" : 4683
    "free" : 39553
```
