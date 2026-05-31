from collections import defaultdict, deque
from typing import Dict, List, Optional


def topological_sort(deps: Dict[str, List[str]]) -> Optional[List[str]]:
    """Kahn's algorithm for topological ordering of a DAG.

    Args:
        deps: mapping from node to its dependencies (edges go dep → node).

    Returns:
        Ordered list if the graph is a DAG, or None if a cycle exists.
    """
    in_degree: Dict[str, int] = defaultdict(int)
    # Ensure all nodes appear even if they have zero in-edges.
    for node in deps:
        in_degree.setdefault(node, 0)
        for dep in deps[node]:
            in_degree[dep] = in_degree.get(dep, 0)
            in_degree[node] += 1

    queue = deque(n for n, d in in_degree.items() if d == 0)
    order = []
    while queue:
        n = queue.popleft()
        order.append(n)
        for node, d_list in deps.items():
            if n in d_list:
                in_degree[node] -= 1
                if in_degree[node] == 0:
                    queue.append(node)
    return order if len(order) == len(in_degree) else None
