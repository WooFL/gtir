from collections import deque
from typing import Dict, List, Optional


def bfs(graph: Dict[str, List[str]], start: str) -> List[str]:
    """Breadth-first traversal; returns nodes in visit order."""
    visited = {start}
    queue = deque([start])
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for neighbor in graph.get(node, []):
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    return order


def shortest_path(graph: Dict[str, List[str]], src: str, dst: str) -> Optional[List[str]]:
    """Find the shortest unweighted path via BFS; returns None if unreachable."""
    parent: Dict[str, Optional[str]] = {src: None}
    queue = deque([src])
    while queue:
        node = queue.popleft()
        if node == dst:
            path = []
            cur: Optional[str] = dst
            while cur is not None:
                path.append(cur)
                cur = parent[cur]
            return list(reversed(path))
        for neighbor in graph.get(node, []):
            if neighbor not in parent:
                parent[neighbor] = node
                queue.append(neighbor)
    return None
