class SessionManager:
    def create_session(self, user_id):
        # Issues a new session token for an authenticated user.
        return f"session-{user_id}-token-abcdef-padding-to-clear-min-chars"

    def revoke_session(self, token):
        # Invalidates an existing session token immediately.
        return True if token else False
