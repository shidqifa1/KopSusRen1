(function () {
  async function request(path, options = {}) {
    const token = sessionStorage.getItem('kopi_session');
    if (!token) throw new Error('Sesi login tidak tersedia');
    const response = await fetch(path, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (response.status === 401) {
      sessionStorage.removeItem('kopi_session');
      throw new Error('Sesi login habis. Login ulang dulu ya.');
    }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || raw?.slice(0, 180) || `Operasi gagal (${response.status})`);
    }
    return data;
  }

  function command(action, payload) {
    return request('/api/v2/commands', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    });
  }

  window.kopsusrenServices = {
    bootstrap: scope => request(scope ? `/api/v2/bootstrap?scope=${encodeURIComponent(scope)}` : '/api/v2/bootstrap'),
    recordQuickSale: payload => command('record_quick_sale', payload),
    recordPurchase: payload => command('record_purchase', payload),
    createOrder: payload => command('create_order', payload),
    cancelOrder: (orderId, reason) => command('cancel_order', { orderId, reason }),
    confirmCashPayment: orderId => command('confirm_cash_payment', { orderId }),
    confirmPayment: orderId => command('confirm_cash_payment', { orderId }),
    completeOrder: orderId => command('complete_order', { orderId }),
    voidOrder: (orderId, reason) => command('void_order', { orderId, reason }),
    updateSaleDetails: payload => command('edit_sale_details', payload),
    createPo: payload => command('create_po', payload),
    openPoNow: (poSessionId, cutoffAt, maxTotalCups, ingredientLimits) => command('open_po_now', { poSessionId, cutoffAt, maxTotalCups, ingredientLimits }),
    setPoStatus: (poSessionId, status) => command('set_po_status', { poSessionId, status }),
    adjustInventory: payload => command('adjust_inventory', payload),
    adjustAccount: payload => command('adjust_account', payload),
    settleQris: payload => command('settle_qris', payload),
    updateIngredient: payload => command('update_ingredient', payload),
    updateProductRecipe: payload => command('update_product_recipe', payload),
    recordHistoricalSales: payload => command('record_historical_sales', payload),
    importSales: payload => command('import_sales', payload),
    importCash: payload => command('import_cash', payload),
    importSettings: payload => command('import_settings', payload),
    exportHistory: type => request(`/api/v2/export?type=${encodeURIComponent(type)}`),
  };
})();
