using System;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Diagramon.ViewModels;

namespace Diagramon.Views;

public partial class AISettingsDialog : Window
{
    public AISettingsDialog()
    {
        InitializeComponent();
    }

    public AISettingsDialog(AISettingsViewModel viewModel) : this()
    {
        DataContext = viewModel;
    }
}
