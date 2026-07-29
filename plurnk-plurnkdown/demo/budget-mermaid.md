# Budget as dynamic Mermaid

Both diagrams use the full ceiling of 44236.

## Turn composition

Turn boxes, `system + context`, and `free` compose the ceiling.

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

## Largest open log bodies

| item | body tokens |
|---|--:|
| log:///1/1/5/READ | 731 |
| log:///1/7/1/READ | 145 |
| log:///1/6/1/READ | 112 |

## Used and free

Used and free sum to the ceiling.

```mermaid
pie showData
    title Budget — used vs free (ceiling 44236)
    "used" : 4683
    "free" : 39553
```
