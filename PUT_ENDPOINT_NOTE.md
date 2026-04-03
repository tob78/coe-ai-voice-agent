# PUT /api/customers/:id Endpoint Needed

The CRM frontend now includes an "Edit Customer" modal that attempts to save via `PUT /api/customers/:id` first, then falls back to `PATCH /api/customers/:id`.

## Required endpoint in server.js:

```javascript
// PUT /api/customers/:id - Full customer update
app.put('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, address, postal_code, service_requested, preferred_date, preferred_time, status, comment } = req.body;
  
  try {
    await db.run(
      `UPDATE customers SET name=?, phone=?, address=?, postal_code=?, service_requested=?, preferred_date=?, preferred_time=?, status=?, comment=? WHERE id=?`,
      [name, phone, address, postal_code, service_requested, preferred_date, preferred_time, status, comment, id]
    );
    const customer = await db.get('SELECT * FROM customers WHERE id=?', [id]);
    res.json(customer);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/customers/:id - Delete a customer  
app.delete('/api/customers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM customers WHERE id=?', [id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
```

**Note:** The frontend currently falls back to PATCH if PUT fails. If PATCH already handles all fields, this works. But for a clean implementation, add both PUT and DELETE endpoints to server.js.
