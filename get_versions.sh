echo "=== HEAD VERSION ==="
# We can't easily see the actual files as they were before conflict markers,
# but the conflict markers themselves show the content.
# I will check the file content after the conflict markers to see if there are any other conflicts.
grep -n "<<<<<<<" artifacts/api-server/src/routes/training.ts
grep -n ">>>>>>>" artifacts/api-server/src/routes/training.ts
