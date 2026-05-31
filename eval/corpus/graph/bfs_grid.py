from collections import deque
from typing import List, Optional, Tuple


def grid_shortest_path(grid: List[List[int]], start: Tuple[int, int], goal: Tuple[int, int]) -> Optional[int]:
    """Shortest path length on a 2D grid via BFS; cells equal to 1 are blocked, returns None if unreachable."""
    rows, cols = len(grid), len(grid[0])
    seen = {start}
    queue = deque([(start, 0)])
    while queue:
        (r, c), dist = queue.popleft()
        if (r, c) == goal:
            return dist
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 0 and (nr, nc) not in seen:
                seen.add((nr, nc))
                queue.append(((nr, nc), dist + 1))
    return None
